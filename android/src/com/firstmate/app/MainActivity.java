package com.firstmate.app;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/** Pairing on first run; afterwards the live transcript, guide and backlog. */
public class MainActivity extends Activity {
    private static final int PERMS = 1;
    private Prefs prefs;
    private WebView web;
    private String pendingServer;
    private String pendingCode;

    // Night at sea: navy, parchment and brass.
    private static final int BG = Color.parseColor("#0c1620");
    private static final int PANEL = Color.parseColor("#142331");
    private static final int INK = Color.parseColor("#efe4cc");
    private static final int MUTED = Color.parseColor("#a8b3b8");
    private static final int ACCENT = Color.parseColor("#d8b065");
    private static final int WARN = Color.parseColor("#ef7b68");

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        prefs = new Prefs(this);
        readPairLink(getIntent());
        if (prefs.paired()) showRadio(); else showPairing(null);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (readPairLink(intent)) showPairing(null);
    }

    /** firstmate://pair?server=host:port&code=123456 */
    private boolean readPairLink(Intent intent) {
        Uri u = intent == null ? null : intent.getData();
        if (u == null || !"firstmate".equals(u.getScheme())) return false;
        pendingServer = u.getQueryParameter("server");
        pendingCode = u.getQueryParameter("code");
        return true;
    }

    // ---- pairing ----

    private int dp(int v) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics());
    }

    private TextView text(String s, int sp, int color) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(sp);
        t.setTextColor(color);
        t.setLineSpacing(0, 1.2f);
        return t;
    }

    private EditText field(String hint, String value, int type) {
        EditText e = new EditText(this);
        e.setHint(hint);
        e.setText(value);
        e.setInputType(type);
        e.setTextColor(INK);
        e.setHintTextColor(MUTED);
        e.setTextSize(20);
        e.setSingleLine(true);
        return e;
    }

    private void showPairing(String error) {
        if (web != null) { web.destroy(); web = null; }
        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(BG);
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setPadding(dp(24), dp(48), dp(24), dp(24));
        scroll.addView(col);

        TextView title = text("First Mate", 50, ACCENT);
        title.setTypeface(pirate());
        col.addView(title);
        TextView lede = text("Yer crew of Claude agents, at the captain's word.", 17, INK);
        lede.setTypeface(Typeface.create(Typeface.SERIF, Typeface.ITALIC));
        col.addView(lede);
        col.addView(gap(16));
        col.addView(text("To come aboard: turn on Tailscale on this phone, then open the pairing page on your computer (localhost:7373/pair) for a six-digit code.", 16, MUTED));

        col.addView(gap(24));
        col.addView(text("Server", 14, MUTED));
        final EditText server = field("100.x.y.z:7373", pendingServer != null ? pendingServer : prefs.server(), InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        col.addView(server);
        col.addView(gap(12));
        col.addView(text("Pairing code", 14, MUTED));
        final EditText code = field("123 456", pendingCode != null ? pendingCode : "", InputType.TYPE_CLASS_NUMBER);
        code.setTextSize(28);
        code.setLetterSpacing(0.15f);
        col.addView(code);

        final TextView status = text(error == null ? "" : error, 15, error == null ? MUTED : WARN);
        col.addView(gap(8));
        col.addView(status);

        Button go = new Button(this);
        go.setText("Come aboard");
        go.setTextSize(19);
        go.setAllCaps(false);
        go.setTypeface(pirate());
        go.setTextSize(24);
        android.graphics.drawable.GradientDrawable shape = new android.graphics.drawable.GradientDrawable();
        shape.setColor(ACCENT);
        shape.setCornerRadius(dp(12));
        go.setBackground(shape);
        go.setTextColor(Color.parseColor("#1a1408"));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(56));
        lp.topMargin = dp(16);
        go.setLayoutParams(lp);
        col.addView(go);
        go.setOnClickListener(v -> {
            final String s = server.getText().toString().trim();
            final String c = code.getText().toString().replaceAll("\\D", "");
            if (s.isEmpty() || c.length() != 6) {
                status.setText("Enter the server address and the six-digit code.");
                return;
            }
            status.setTextColor(MUTED);
            status.setText("Hailing the ship…");
            go.setEnabled(false);
            new Thread(() -> {
                String err = pair(s, c);
                runOnUiThread(() -> {
                    go.setEnabled(true);
                    if (err == null) {
                        pendingServer = null;
                        pendingCode = null;
                        showRadio();
                    } else {
                        status.setTextColor(WARN);
                        status.setText(err);
                    }
                });
            }).start();
        });
        // Arrived from a pairing link with both filled in: go straight ahead.
        if (pendingServer != null && pendingCode != null && error == null) go.post(go::performClick);
        setContentView(scroll);
    }

    /** Pirata One, bundled in res/font. */
    private Typeface pirate() {
        try {
            return getResources().getFont(R.font.pirata_one);
        } catch (Exception e) {
            return Typeface.create(Typeface.SERIF, Typeface.BOLD);
        }
    }

    private View gap(int h) {
        View v = new View(this);
        v.setLayoutParams(new LinearLayout.LayoutParams(1, dp(h)));
        return v;
    }

    /** Returns null on success, or a message to show. */
    private String pair(String server, String code) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(Prefs.httpBase(server) + "/pair").openConnection();
            c.setConnectTimeout(8000);
            c.setReadTimeout(8000);
            c.setRequestMethod("POST");
            c.setDoOutput(true);
            c.setRequestProperty("content-type", "application/json");
            byte[] body = new JSONObject().put("code", code).put("device", Build.MODEL).toString().getBytes(StandardCharsets.UTF_8);
            try (OutputStream o = c.getOutputStream()) { o.write(body); }
            int status = c.getResponseCode();
            InputStream in = status < 400 ? c.getInputStream() : c.getErrorStream();
            String reply = read(in);
            if (status == 200) {
                prefs.pair(server, new JSONObject(reply).getString("token"));
                return null;
            }
            if (status == 403 && reply.contains("error")) return new JSONObject(reply).optString("error", "Refused.");
            return "The dispatcher refused (" + status + "). Is this phone on Tailscale?";
        } catch (java.net.SocketTimeoutException | java.net.ConnectException e) {
            return "Could not reach " + server + ". Check Tailscale is on, on both devices, and the dispatcher is running.";
        } catch (Exception e) {
            return "Pairing failed: " + e.getMessage();
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private static String read(InputStream in) throws java.io.IOException {
        if (in == null) return "";
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        byte[] buf = new byte[4096];
        for (int n; (n = in.read(buf)) > 0; ) b.write(buf, 0, n);
        return b.toString("UTF-8");
    }

    // ---- the radio screen ----

    private void showRadio() {
        if (needPermissions()) return;
        startRadio();
        if (web == null) {
            web = new WebView(this);
            web.setBackgroundColor(BG);
            WebSettings s = web.getSettings();
            s.setJavaScriptEnabled(true);
            s.setDomStorageEnabled(true);
            s.setMediaPlaybackRequiresUserGesture(false);
            s.setCacheMode(WebSettings.LOAD_NO_CACHE);
            web.addJavascriptInterface(new Bridge(), "FirstMateNative");
            web.setWebViewClient(new WebViewClient() {
                @Override
                public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
                    if (req.isForMainFrame()) showOffline(view);
                }
            });
            setContentView(web);
        }
        loadPage();
    }

    private void loadPage() {
        try {
            String url = Prefs.httpBase(prefs.server()) + "/?native=1&t=" + URLEncoder.encode(prefs.token(), "UTF-8");
            web.loadUrl(url);
        } catch (Exception e) {
            showOffline(web);
        }
    }

    private void showOffline(WebView view) {
        String html = "<html><body style='background:#0c1620;color:#efe4cc;font:17px system-ui;padding:32px'>"
                + "<h2 style='font-family:serif;color:#d8b065'>No sight of the ship</h2><p style='color:#a8b3b8'>Can't reach the dispatcher. Trying " + Prefs.httpBase(prefs.server())
                + " again every few seconds. Check Tailscale is on, on both devices, and the dispatcher is running on the computer.</p>"
                + "<p style='color:#a8b3b8'>The radio keeps running in the background and reconnects on its own.</p>"
                + "<script>setTimeout(function(){FirstMateNative.reload()},5000)</script></body></html>";
        view.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
    }

    private void startRadio() {
        Intent i = new Intent(this, RadioService.class).setAction(RadioService.ACTION_START);
        startForegroundService(i);
    }

    private boolean needPermissions() {
        List<String> want = new ArrayList<>();
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) want.add(Manifest.permission.RECORD_AUDIO);
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) want.add(Manifest.permission.POST_NOTIFICATIONS);
        if (Build.VERSION.SDK_INT >= 31 && checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) want.add(Manifest.permission.BLUETOOTH_CONNECT);
        if (want.isEmpty()) return false;
        requestPermissions(want.toArray(new String[0]), PERMS);
        return true;
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        if (code != PERMS) return;
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            showRadio();
        } else {
            ScrollView v = new ScrollView(this);
            v.setBackgroundColor(BG);
            TextView t = text("First Mate needs the microphone to hear you. Allow it in Settings, Apps, First Mate, Permissions, then reopen the app.", 18, INK);
            t.setPadding(dp(24), dp(48), dp(24), dp(24));
            t.setGravity(Gravity.START);
            v.addView(t);
            setContentView(v);
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        RadioService.ui = script -> runOnUiThread(() -> { if (web != null) web.evaluateJavascript(script, null); });
        if (web != null) web.evaluateJavascript("window.mateSync&&mateSync(" + RadioService.lastDone + ")", null);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }

    @Override
    protected void onPause() {
        RadioService.ui = null;
        getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        super.onPause();
    }

    @Override
    public void onBackPressed() {
        moveTaskToBack(true); // keep the radio on air
    }

    /** Called from the transcript page. */
    private final class Bridge {
        @JavascriptInterface
        public String info() { return RadioService.infoJson(); }

        @JavascriptInterface
        public void setMic(boolean on) { RadioService r = RadioService.instance; if (r != null) r.setMic(on); }

        @JavascriptInterface
        public void interrupt() { RadioService r = RadioService.instance; if (r != null) r.interrupt(); }

        @JavascriptInterface
        public String voices() { RadioService r = RadioService.instance; return r == null ? "[]" : r.voicesJson(); }

        @JavascriptInterface
        public void setVoice(String name) { RadioService r = RadioService.instance; if (r != null) r.chooseVoice(name); }

        @JavascriptInterface
        public void setHeadsetMic(boolean on) { RadioService r = RadioService.instance; if (r != null) r.setHeadsetMic(on); }

        @JavascriptInterface
        public void startRadio() { runOnUiThread(MainActivity.this::startRadio); }

        @JavascriptInterface
        public void stopRadio() {
            startService(new Intent(MainActivity.this, RadioService.class).setAction(RadioService.ACTION_STOP));
        }

        @JavascriptInterface
        public void reload() { runOnUiThread(MainActivity.this::loadPage); }

        @JavascriptInterface
        public void unpair() {
            stopRadio();
            prefs.unpair();
            runOnUiThread(() -> showPairing(null));
        }
    }
}
