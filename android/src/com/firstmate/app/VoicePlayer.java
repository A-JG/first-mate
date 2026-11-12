package com.firstmate.app;

import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioTrack;
import android.util.Log;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

/**
 * Plays the First Mate's voice as it streams in from the computer, a sentence
 * at a time, and reports which word is being heard so the transcript can
 * follow along and an interrupt knows where it cut in.
 */
final class VoicePlayer {
    interface Events {
        /** state: start | range | done | stopped; at: character offset in the line. */
        void progress(int id, String state, int at);
    }

    static final class Chunk {
        int id;
        int seq;
        boolean last;
        int rate;
        int[] markAt = new int[0];
        int[] markMs = new int[0];
        byte[] pcm;
    }

    /** One chunk's place on the timeline of frames written to the track. */
    private static final class Seg {
        int id;
        boolean last;
        long start;
        long end;
        long[] markFrame;
        int[] markAt;
    }

    private final Events events;
    private final LinkedBlockingQueue<Chunk> queue = new LinkedBlockingQueue<>();
    private final List<Seg> timeline = new ArrayList<>();
    private final Set<Integer> started = new HashSet<>();
    private volatile AudioAttributes attributes;
    private volatile boolean running = true;
    private volatile long generation;
    private AudioTrack track;
    private int trackRate;
    private long written;
    private int currentId = -1;
    private int lastAt = -1;

    VoicePlayer(AudioAttributes attributes, Events events) {
        this.attributes = attributes;
        this.events = events;
        new Thread(this::writer, "firstmate-voice").start();
        new Thread(this::ticker, "firstmate-voice-clock").start();
    }

    void add(Chunk c) {
        queue.add(c);
    }

    void setAttributes(AudioAttributes a) {
        attributes = a;
        synchronized (this) {
            trackRate = 0; // rebuilt with the new routing on the next chunk
        }
    }

    private volatile boolean paused;

    /** Hold playback exactly where it is: the operator started talking. */
    void pause() {
        synchronized (this) {
            paused = true;
            if (track != null) track.pause();
        }
    }

    /** Carry on from exactly where it paused. */
    void resume() {
        synchronized (this) {
            paused = false;
            if (track != null) track.play();
        }
    }

    /** Cut everything short: the operator said the interrupt word. */
    void stop() {
        generation++;
        queue.clear();
        int cut;
        synchronized (this) {
            cut = currentId;
            if (track != null) {
                track.pause();
                track.flush();
                track.play();
            }
            paused = false;
            written = 0;
            timeline.clear();
            currentId = -1;
            lastAt = -1;
        }
        if (cut >= 0) events.progress(cut, "stopped", 0);
    }

    void release() {
        running = false;
        synchronized (this) {
            if (track != null) track.release();
            track = null;
        }
    }

    boolean busy() {
        synchronized (this) {
            return currentId >= 0 || !timeline.isEmpty() || !queue.isEmpty();
        }
    }

    private void writer() {
        while (running) {
            Chunk c;
            try {
                c = queue.poll(500, TimeUnit.MILLISECONDS);
            } catch (InterruptedException e) {
                return;
            }
            if (c == null) continue;
            long gen = generation;
            AudioTrack t;
            synchronized (this) {
                if (track == null || trackRate != c.rate) {
                    if (track != null) track.release();
                    track = build(c.rate);
                    trackRate = c.rate;
                    written = 0;
                    timeline.clear();
                    if (!paused) track.play();
                }
                t = track;
                Seg s = new Seg();
                s.id = c.id;
                s.last = c.last;
                s.start = written;
                s.end = written + c.pcm.length / 2;
                s.markAt = c.markAt;
                s.markFrame = new long[c.markMs.length];
                for (int i = 0; i < c.markMs.length; i++) s.markFrame[i] = s.start + (long) c.markMs[i] * c.rate / 1000;
                timeline.add(s);
                written = s.end;
            }
            // Write in small pieces so an interrupt takes effect at once.
            int piece = c.rate / 10 * 2;
            for (int off = 0; off < c.pcm.length && gen == generation && running; off += piece) {
                int n = Math.min(piece, c.pcm.length - off);
                int r = t.write(c.pcm, off, n);
                if (r < 0) {
                    Log.w(RadioService.TAG, "voice write failed: " + r);
                    break;
                }
            }
        }
    }

    /** Follows the playback position and reports start, words and the end of each line. */
    private void ticker() {
        while (running) {
            try {
                Thread.sleep(40);
            } catch (InterruptedException e) {
                return;
            }
            int startId = -1, doneId = -1, rangeId = -1, rangeAt = -1;
            synchronized (this) {
                if (track == null || timeline.isEmpty()) continue;
                long head = track.getPlaybackHeadPosition() & 0xffffffffL;
                Seg seg = null;
                for (Seg s : timeline) {
                    if (head < s.end) { seg = s; break; }
                }
                if (seg == null) {
                    // Everything written has played. Finish the line if it was complete.
                    Seg tail = timeline.get(timeline.size() - 1);
                    if (tail.last && currentId == tail.id && !paused) {
                        doneId = tail.id;
                        currentId = -1;
                        lastAt = -1;
                        timeline.clear();
                        written = 0;
                        track.pause();
                        track.flush();
                        track.play();
                    }
                } else if (!paused) {
                    if (seg.id != currentId) {
                        if (currentId >= 0) doneId = currentId;
                        currentId = seg.id;
                        lastAt = -1;
                        if (started.add(seg.id) || seg.id == 0) startId = seg.id;
                    }
                    int at = -1;
                    for (int i = 0; i < seg.markFrame.length; i++) if (seg.markFrame[i] <= head) at = seg.markAt[i];
                    if (at >= 0 && at != lastAt) {
                        lastAt = at;
                        rangeId = seg.id;
                        rangeAt = at;
                    }
                    // Drop segments of lines that have fully played.
                    while (timeline.size() > 1 && timeline.get(0).end <= head && timeline.get(0).id != currentId) timeline.remove(0);
                }
                if (started.size() > 200) started.clear();
            }
            if (doneId >= 0) events.progress(doneId, "done", 0);
            if (startId >= 0) events.progress(startId, "start", 0);
            if (rangeId >= 0) events.progress(rangeId, "range", rangeAt);
        }
    }

    private AudioTrack build(int rate) {
        int min = AudioTrack.getMinBufferSize(rate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT);
        return new AudioTrack.Builder()
                .setAudioAttributes(attributes)
                .setAudioFormat(new AudioFormat.Builder().setSampleRate(rate)
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
                .setBufferSizeInBytes(Math.max(min * 2, rate / 2 * 2))
                .setTransferMode(AudioTrack.MODE_STREAM)
                .build();
    }
}
