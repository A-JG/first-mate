package com.firstmate.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.media.AudioDeviceCallback;
import android.media.AudioDeviceInfo;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioRecord;
import android.media.AudioTrack;
import android.media.MediaRecorder;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;
import android.util.Log;
import android.view.KeyEvent;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * The radio itself, running in the foreground so it keeps working with the
 * screen off: streams the microphone to the dispatcher, speaks what it is
 * told to say, and reports which word it is on so the operator can cut in.
 */
public class RadioService extends Service {
    static final String TAG = "firstmate";
    static final String ACTION_START = "com.firstmate.app.START";
    static final String ACTION_STOP = "com.firstmate.app.STOP";
    static final String ACTION_MIC = "com.firstmate.app.MIC";
    static final String ACTION_INTERRUPT = "com.firstmate.app.INTERRUPT";
    private static final int NOTE_ID = 7373;
    private static final int RATE = 16000;

    /** Receives speech progress for the on-screen transcript while the app is open. */
    interface Ui {
        void js(String script);
    }

    static volatile RadioService instance;
    static volatile Ui ui;
    static volatile int lastDone;

    private final Handler main = new Handler(Looper.getMainLooper());
    private Prefs prefs;
    private volatile boolean running;
    private volatile MiniWebSocket ws;
    private volatile boolean connected;
    private volatile boolean everConnected;
    private volatile boolean micOn = true;
    private volatile String status = "Starting";
    private volatile String interruptWord = "avast";
    private Thread netThread;
    private Thread micThread;
    private TextToSpeech tts;
    private boolean ttsReady;
    private final List<Object[]> waiting = new ArrayList<>();
    private float pitch = 0.85f;
    private float rate = 0.95f;
    private float denseRate = 0.85f;
    private AudioManager audio;
    private volatile boolean commMode;
    private volatile String headset = null;
    private volatile AudioDeviceInfo inputDevice;
    private PowerManager.WakeLock wake;
    private MediaSession session;
    private Tones tones;
    /** The First Mate's voice, streamed from the computer. */
    private VoicePlayer voice;
    private VoicePlayer.Chunk pendingChunk;
    /** Lines promised as audio; if none arrives in time the phone's own voice says them. */
    private final java.util.Map<Integer, Runnable> fallbacks = new java.util.concurrent.ConcurrentHashMap<>();

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? ACTION_START : intent.getAction();
        if (ACTION_STOP.equals(action)) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (!running) begin();
        if (ACTION_MIC.equals(action)) setMic(!micOn);
        if (ACTION_INTERRUPT.equals(action)) interrupt();
        return START_STICKY;
    }

    // ---- lifecycle ----

    private void begin() {
        prefs = new Prefs(this);
        instance = this;
        running = true;
        NotificationManager nm = getSystemService(NotificationManager.class);
        nm.createNotificationChannel(new NotificationChannel("radio", "On air", NotificationManager.IMPORTANCE_LOW));
        int types = ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE | ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK;
        startForeground(NOTE_ID, buildNotification(), types);

        PowerManager pm = getSystemService(PowerManager.class);
        wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "firstmate:radio");
        wake.acquire();

        audio = getSystemService(AudioManager.class);
        routeAudio();
        audio.registerAudioDeviceCallback(new AudioDeviceCallback() {
            @Override
            public void onAudioDevicesAdded(AudioDeviceInfo[] added) { main.postDelayed(RadioService.this::routeAudio, 800); }

            @Override
            public void onAudioDevicesRemoved(AudioDeviceInfo[] removed) { main.postDelayed(RadioService.this::routeAudio, 800); }
        }, main);

        tones = new Tones();
        voice = new VoicePlayer(speechAttributes(), (id, state, at) -> played("say-" + id, state, at, at));
        startSpeech();
        startMediaButton();
        startNetwork();
        startMic();
    }

    @Override
    public void onDestroy() {
        running = false;
        instance = null;
        MiniWebSocket s = ws;
        if (s != null) s.close();
        if (netThread != null) netThread.interrupt();
        if (tts != null) tts.shutdown();
        if (voice != null) voice.release();
        if (session != null) session.release();
        if (audio != null) {
            if (Build.VERSION.SDK_INT >= 31) audio.clearCommunicationDevice();
            else audio.stopBluetoothSco();
            audio.setMode(AudioManager.MODE_NORMAL);
        }
        if (wake != null && wake.isHeld()) wake.release();
        pushUi("window.mateRadio&&mateRadio(" + infoJson() + ")");
        super.onDestroy();
    }

    // ---- audio routing: earbuds when present ----

    private void routeAudio() {
        if (audio == null) return;
        boolean want = prefs.headsetMic();
        headset = null;
        inputDevice = null;
        if (!want) {
            if (Build.VERSION.SDK_INT >= 31) audio.clearCommunicationDevice();
            else audio.stopBluetoothSco();
            audio.setMode(AudioManager.MODE_NORMAL);
            commMode = false;
        } else {
            audio.setMode(AudioManager.MODE_IN_COMMUNICATION);
            commMode = true;
            if (Build.VERSION.SDK_INT >= 31) {
                AudioDeviceInfo best = null;
                int bestRank = 0;
                for (AudioDeviceInfo d : audio.getAvailableCommunicationDevices()) {
                    int rank = rank(d.getType());
                    if (rank > bestRank) { best = d; bestRank = rank; }
                }
                if (best != null) {
                    audio.setCommunicationDevice(best);
                    headset = String.valueOf(best.getProductName());
                    for (AudioDeviceInfo in : audio.getDevices(AudioManager.GET_DEVICES_INPUTS)) {
                        if (in.getType() == best.getType()) inputDevice = in;
                    }
                } else {
                    audio.clearCommunicationDevice();
                }
            } else {
                audio.startBluetoothSco();
                audio.setBluetoothScoOn(true);
                headset = "headset";
            }
        }
        if (tts != null) tts.setAudioAttributes(speechAttributes());
        if (voice != null) voice.setAttributes(speechAttributes());
        if (tones != null) tones.rebuild();
        updateNotification();
        pushInfo();
    }

    private static int rank(int type) {
        switch (type) {
            case AudioDeviceInfo.TYPE_BLUETOOTH_SCO: return 4;
            case 26 /* TYPE_BLE_HEADSET */: return 3;
            case AudioDeviceInfo.TYPE_WIRED_HEADSET: return 2;
            case AudioDeviceInfo.TYPE_USB_HEADSET: return 1;
            default: return 0;
        }
    }

    private AudioAttributes speechAttributes() {
        return new AudioAttributes.Builder()
                .setUsage(commMode ? AudioAttributes.USAGE_VOICE_COMMUNICATION : AudioAttributes.USAGE_ASSISTANT)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build();
    }

    // ---- speaking ----

    private void startSpeech() {
        tts = new TextToSpeech(this, status -> main.post(() -> {
            if (status != TextToSpeech.SUCCESS) {
                Log.w(TAG, "text to speech failed to start: " + status);
                return;
            }
            ttsReady = true;
            tts.setAudioAttributes(speechAttributes());
            tts.setOnUtteranceProgressListener(progress);
            pickVoice();
            for (Object[] w : waiting) speak((Integer) w[0], (String) w[1], (Boolean) w[2]);
            waiting.clear();
        }));
    }

    /** A British voice that works offline, by preference; or the one the operator chose. */
    private void pickVoice() {
        if (tts == null || tts.getVoices() == null) return;
        String want = prefs.voice();
        Voice chosen = null;
        int best = Integer.MIN_VALUE;
        for (Voice v : tts.getVoices()) {
            if (v.getLocale() == null || !"en".equals(v.getLocale().getLanguage())) continue;
            if (v.getFeatures() != null && v.getFeatures().contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED)) continue;
            if (want != null && v.getName().equals(want)) { chosen = v; break; }
            int score = 0;
            if ("GB".equals(v.getLocale().getCountry())) score += 40;
            if (!v.isNetworkConnectionRequired()) score += 20;
            score += v.getQuality() / 50;
            String n = v.getName().toLowerCase(Locale.ROOT);
            if (n.contains("rjs") || n.contains("gbd") || n.contains("gbb")) score += 15;
            if (score > best) { best = score; chosen = v; }
        }
        if (chosen != null) tts.setVoice(chosen);
    }

    private void speak(int id, String text, boolean dense) {
        if (!ttsReady) {
            waiting.add(new Object[] {id, text, dense});
            return;
        }
        tts.setPitch(pitch);
        tts.setSpeechRate(dense ? denseRate : rate);
        Bundle params = new Bundle();
        params.putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, 1f);
        tts.speak(text, TextToSpeech.QUEUE_ADD, params, "say-" + id);
    }

    private final UtteranceProgressListener progress = new UtteranceProgressListener() {
        @Override
        public void onStart(String uid) { played(uid, "start", 0, 0); }

        @Override
        public void onRangeStart(String uid, int start, int end, int frame) { played(uid, "range", start, end); }

        @Override
        public void onDone(String uid) { played(uid, "done", 0, 0); }

        @Override
        public void onStop(String uid, boolean interrupted) { played(uid, "stopped", 0, 0); }

        @Override
        public void onError(String uid) { played(uid, "done", 0, 0); }
    };

    private void played(String uid, String state, int start, int end) {
        int id;
        try {
            id = Integer.parseInt(uid.substring(4));
        } catch (Exception e) {
            return;
        }
        if ("done".equals(state) || "stopped".equals(state)) lastDone = Math.max(lastDone, id);
        if (id > 0) {
            try {
                send(new JSONObject().put("type", "playback").put("id", id).put("state", state).put("at", start));
            } catch (Exception ignored) {
                // not connected
            }
        }
        pushUi("window.mateSpeech&&mateSpeech('" + state + "'," + id + "," + start + "," + end + ")");
    }

    // ---- listening ----

    private void startMic() {
        micThread = new Thread(() -> {
            int min = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
            AudioRecord rec = null;
            byte[] chunk = new byte[3200]; // 100 ms
            AudioDeviceInfo using = null;
            while (running) {
                try {
                    if (rec == null || using != inputDevice) {
                        if (rec != null) rec.release();
                        int source = commMode ? MediaRecorder.AudioSource.VOICE_COMMUNICATION : MediaRecorder.AudioSource.VOICE_RECOGNITION;
                        rec = new AudioRecord(source, RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, Math.max(min * 2, 6400));
                        using = inputDevice;
                        if (using != null) rec.setPreferredDevice(using);
                        // Cancel the First Mate's own voice and steady background noise.
                        if (android.media.audiofx.AcousticEchoCanceler.isAvailable()) {
                            android.media.audiofx.AcousticEchoCanceler aec = android.media.audiofx.AcousticEchoCanceler.create(rec.getAudioSessionId());
                            if (aec != null) aec.setEnabled(true);
                        }
                        if (android.media.audiofx.NoiseSuppressor.isAvailable()) {
                            android.media.audiofx.NoiseSuppressor ns = android.media.audiofx.NoiseSuppressor.create(rec.getAudioSessionId());
                            if (ns != null) ns.setEnabled(true);
                        }
                        rec.startRecording();
                    }
                    int n = rec.read(chunk, 0, chunk.length);
                    MiniWebSocket s = ws;
                    if (n > 0 && micOn && connected && s != null) s.sendBinary(chunk, 0, n);
                } catch (SecurityException e) {
                    status = "Microphone permission needed";
                    updateNotification();
                    sleep(3000);
                } catch (Exception e) {
                    Log.w(TAG, "mic: " + e);
                    if (rec != null) { rec.release(); rec = null; }
                    sleep(500);
                }
            }
            if (rec != null) rec.release();
        }, "firstmate-mic");
        micThread.start();
    }

    void setMic(boolean on) {
        micOn = on;
        try {
            send(new JSONObject().put("type", "mic").put("on", on));
        } catch (Exception ignored) {
            // not connected
        }
        tones.play(on ? "sent" : "cancel");
        updateNotification();
        pushInfo();
    }

    /** Same as saying the interrupt word: stop talking and listen. */
    void interrupt() {
        main.post(this::hush);
        try {
            send(new JSONObject().put("type", "heard").put("text", interruptWord));
        } catch (Exception ignored) {
            // not connected
        }
    }

    // ---- earbud button: interrupt ----

    private void startMediaButton() {
        session = new MediaSession(this, "firstmate");
        session.setCallback(new MediaSession.Callback() {
            @Override
            public boolean onMediaButtonEvent(Intent intent) {
                KeyEvent ev = intent.getParcelableExtra(Intent.EXTRA_KEY_EVENT);
                if (ev == null || ev.getAction() != KeyEvent.ACTION_DOWN || ev.getRepeatCount() > 0) return true;
                switch (ev.getKeyCode()) {
                    case KeyEvent.KEYCODE_HEADSETHOOK:
                    case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE:
                    case KeyEvent.KEYCODE_MEDIA_PLAY:
                    case KeyEvent.KEYCODE_MEDIA_PAUSE:
                        interrupt();
                        return true;
                    default:
                        return super.onMediaButtonEvent(intent);
                }
            }
        });
        session.setPlaybackState(new PlaybackState.Builder()
                .setActions(PlaybackState.ACTION_PLAY_PAUSE | PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE)
                .setState(PlaybackState.STATE_PLAYING, 0, 1f)
                .build());
        session.setActive(true);
    }

    // ---- network ----

    private void startNetwork() {
        netThread = new Thread(() -> {
            long backoff = 1000;
            while (running) {
                MiniWebSocket s = new MiniWebSocket();
                try {
                    String[] hp = Prefs.hostPort(prefs.server());
                    status = everConnected ? "Reconnecting" : "Connecting";
                    updateNotification();
                    pushInfo();
                    s.connect(hp[0], Integer.parseInt(hp[1]), "/radio?wait=1", 8000);
                    ws = s;
                    s.sendText(new JSONObject()
                            .put("type", "hello").put("token", prefs.token()).put("role", "radio")
                            .put("reconnect", everConnected).put("device", Build.MODEL).toString());
                    s.sendText(new JSONObject().put("type", "speaker").put("on", true).toString());
                    connected = true;
                    everConnected = true;
                    backoff = 1000;
                    status = "On air";
                    updateNotification();
                    pushInfo();
                    s.readLoop(new MiniWebSocket.Listener() {
                        @Override
                        public void onText(String t) { onMessage(t); }

                        @Override
                        public void onBinary(byte[] data) { onAudio(data); }
                    });
                } catch (Exception e) {
                    Log.i(TAG, "link: " + e);
                }
                connected = false;
                ws = null;
                s.close();
                if (s.closeCode == 4401) {
                    status = "Key refused. Open the app and pair again.";
                    updateNotification();
                    pushInfo();
                    backoff = 60_000;
                } else if (running) {
                    status = "Reconnecting";
                    updateNotification();
                    pushInfo();
                }
                sleep(backoff);
                backoff = Math.min(backoff * 2, 15_000);
            }
        }, "firstmate-net");
        netThread.start();
    }

    /** Stop all speech on this phone at once. */
    private void hush() {
        if (tts != null) tts.stop();
        if (voice != null) voice.stop();
        for (Runnable r : fallbacks.values()) main.removeCallbacks(r);
        fallbacks.clear();
    }

    private void onAudio(byte[] pcm) {
        VoicePlayer.Chunk c = pendingChunk;
        pendingChunk = null;
        if (c == null || voice == null) return;
        c.pcm = pcm;
        voice.add(c);
    }

    private void onMessage(String text) {
        try {
            JSONObject m = new JSONObject(text);
            switch (m.optString("type")) {
                case "welcome": {
                    JSONObject v = m.optJSONObject("voice");
                    if (v != null) {
                        pitch = (float) v.optDouble("pitch", pitch);
                        rate = (float) v.optDouble("rate", rate);
                        denseRate = (float) v.optDouble("denseRate", denseRate);
                    }
                    interruptWord = m.optString("interrupt", interruptWord);
                    break;
                }
                case "say": {
                    final int id = m.optInt("id");
                    final String say = m.optString("text");
                    final boolean dense = m.optBoolean("dense");
                    // The computer streams the pirate voice; the phone's own voice is
                    // only for when the computer's voice is unavailable. Never both.
                    if (!m.optBoolean("audio")) main.post(() -> speak(id, say, dense));
                    break;
                }
                case "audio": {
                    VoicePlayer.Chunk c = new VoicePlayer.Chunk();
                    c.id = m.optInt("id");
                    c.seq = m.optInt("seq");
                    c.last = m.optBoolean("last");
                    c.rate = m.optInt("rate", 24000);
                    JSONArray marks = m.optJSONArray("marks");
                    int n = marks == null ? 0 : marks.length();
                    c.markAt = new int[n];
                    c.markMs = new int[n];
                    for (int i = 0; i < n; i++) {
                        JSONArray mk = marks.getJSONArray(i);
                        c.markAt[i] = mk.getInt(0);
                        c.markMs[i] = mk.getInt(1);
                    }
                    pendingChunk = c;
                    break;
                }
                case "tone":
                    tones.play(m.optString("name"));
                    break;
                case "stop":
                    main.post(this::hush);
                    break;
                case "pause": // the operator started talking
                    if (voice != null) voice.pause();
                    main.post(() -> { if (tts != null) tts.stop(); });
                    break;
                case "resume":
                    if (voice != null) voice.resume();
                    break;
                default:
                    break;
            }
        } catch (Exception e) {
            Log.w(TAG, "bad message: " + e);
        }
    }

    private void send(JSONObject msg) throws Exception {
        MiniWebSocket s = ws;
        if (s != null && connected) s.sendText(msg.toString());
    }

    // ---- notification ----

    private Notification buildNotification() {
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent openPi = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        String detail = status + (connected ? (micOn ? " · listening" : " · mic off") : "") + (headset != null ? " · " + headset : "");
        return new Notification.Builder(this, "radio")
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle("First Mate")
                .setContentText(detail)
                .setOngoing(true)
                .setContentIntent(openPi)
                .setCategory(Notification.CATEGORY_SERVICE)
                .addAction(new Notification.Action.Builder(null, interruptWord.substring(0, 1).toUpperCase(Locale.ROOT) + interruptWord.substring(1), action(ACTION_INTERRUPT, 1)).build())
                .addAction(new Notification.Action.Builder(null, micOn ? "Mic off" : "Mic on", action(ACTION_MIC, 2)).build())
                .addAction(new Notification.Action.Builder(null, "Stop", action(ACTION_STOP, 3)).build())
                .build();
    }

    private PendingIntent action(String name, int code) {
        Intent i = new Intent(this, RadioService.class).setAction(name);
        return PendingIntent.getService(this, code, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private void updateNotification() {
        if (!running) return;
        main.post(() -> {
            if (running) getSystemService(NotificationManager.class).notify(NOTE_ID, buildNotification());
        });
    }

    // ---- bridge to the screen ----

    static void pushUi(String script) {
        Ui u = ui;
        if (u != null) u.js(script);
    }

    private void pushInfo() {
        pushUi("window.mateRadio&&mateRadio(" + infoJson() + ")");
    }

    static String infoJson() {
        RadioService r = instance;
        JSONObject o = new JSONObject();
        try {
            o.put("running", r != null && r.running);
            if (r != null) {
                o.put("connected", r.connected).put("status", r.status).put("mic", r.micOn)
                        .put("headset", r.headset == null ? JSONObject.NULL : r.headset)
                        .put("headsetMic", r.prefs.headsetMic())
                        .put("voice", r.tts != null && r.tts.getVoice() != null ? r.tts.getVoice().getName() : JSONObject.NULL);
            }
            o.put("lastDone", lastDone);
        } catch (Exception ignored) {
            // best effort
        }
        return o.toString();
    }

    String voicesJson() {
        JSONArray a = new JSONArray();
        if (tts == null || tts.getVoices() == null) return a.toString();
        for (Voice v : tts.getVoices()) {
            if (v.getLocale() == null || !"en".equals(v.getLocale().getLanguage())) continue;
            if (v.getFeatures() != null && v.getFeatures().contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED)) continue;
            try {
                a.put(new JSONObject().put("name", v.getName()).put("locale", v.getLocale().toLanguageTag())
                        .put("network", v.isNetworkConnectionRequired()).put("quality", v.getQuality()));
            } catch (Exception ignored) {
                // skip
            }
        }
        return a.toString();
    }

    void chooseVoice(String name) {
        prefs.voice(name);
        main.post(() -> {
            pickVoice();
            speak(0, "Ahoy, captain. This be my voice.", false);
            pushInfo();
        });
    }

    void setHeadsetMic(boolean on) {
        prefs.headsetMic(on);
        main.post(this::routeAudio);
    }

    private static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException ignored) {
            // woken to stop
        }
    }

    // ---- soft signal tones ----

    private final class Tones {
        private final java.util.Map<String, AudioTrack> tracks = new java.util.HashMap<>();
        private final int sr = 24000;

        void rebuild() {
            for (AudioTrack t : tracks.values()) t.release();
            tracks.clear();
        }

        void play(String name) {
            main.post(() -> {
                try {
                    AudioTrack t = tracks.get(name);
                    if (t == null) {
                        t = make(name);
                        if (t == null) return;
                        tracks.put(name, t);
                    }
                    t.stop();
                    t.reloadStaticData();
                    t.play();
                } catch (Exception e) {
                    Log.w(TAG, "tone: " + e);
                }
            });
        }

        private AudioTrack make(String name) {
            int[] notes;
            switch (name) {
                case "traffic": notes = new int[] {660, 880}; break;
                case "sent": notes = new int[] {880}; break;
                case "working": notes = new int[] {440}; break;
                case "cancel": notes = new int[] {330, 262}; break;
                case "stop": notes = new int[] {520, 390}; break;
                default: notes = new int[] {520}; break;
            }
            int each = sr * 140 / 1000;
            short[] pcm = new short[each * notes.length];
            for (int n = 0; n < notes.length; n++) {
                for (int i = 0; i < each; i++) {
                    double t = (double) i / sr;
                    double env = Math.min(1, i / (sr * 0.015)) * Math.min(1, (each - i) / (sr * 0.04));
                    pcm[n * each + i] = (short) (Math.sin(2 * Math.PI * notes[n] * t) * env * 0.22 * Short.MAX_VALUE);
                }
            }
            AudioTrack t = new AudioTrack.Builder()
                    .setAudioAttributes(new AudioAttributes.Builder()
                            .setUsage(commMode ? AudioAttributes.USAGE_VOICE_COMMUNICATION : AudioAttributes.USAGE_ASSISTANCE_SONIFICATION)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
                    .setAudioFormat(new AudioFormat.Builder().setSampleRate(sr)
                            .setEncoding(AudioFormat.ENCODING_PCM_16BIT).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
                    .setBufferSizeInBytes(pcm.length * 2)
                    .setTransferMode(AudioTrack.MODE_STATIC)
                    .build();
            t.write(pcm, 0, pcm.length);
            return t;
        }
    }
}
