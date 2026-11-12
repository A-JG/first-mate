package com.firstmate.app;

import android.content.Context;
import android.content.SharedPreferences;

/** Saved settings: where the dispatcher is, the key, and audio choices. */
final class Prefs {
    private final SharedPreferences p;

    Prefs(Context c) {
        p = c.getSharedPreferences("firstmate", Context.MODE_PRIVATE);
    }

    String server() { return p.getString("server", Defaults.SERVER); }
    String token() { return p.getString("token", null); }
    boolean paired() { return token() != null; }
    void pair(String server, String token) { p.edit().putString("server", server).putString("token", token).apply(); }
    void unpair() { p.edit().remove("token").apply(); }

    /** Route the mic and speech through earbuds (Bluetooth hands-free) when connected. */
    boolean headsetMic() { return p.getBoolean("headsetMic", true); }
    void headsetMic(boolean on) { p.edit().putBoolean("headsetMic", on).apply(); }

    String voice() { return p.getString("voice", null); }
    void voice(String name) { p.edit().putString("voice", name).apply(); }

    /** "host:port", "[v6]:port" or just "host" -> host and port. */
    static String[] hostPort(String server) {
        String s = server.trim().replaceFirst("^[a-zA-Z]+://", "").replaceAll("/.*$", "");
        String host = s;
        int port = 7373;
        if (s.startsWith("[")) {
            int end = s.indexOf(']');
            host = s.substring(1, end);
            if (s.length() > end + 2 && s.charAt(end + 1) == ':') port = Integer.parseInt(s.substring(end + 2));
        } else if (s.indexOf(':') > 0 && s.indexOf(':') == s.lastIndexOf(':')) {
            host = s.substring(0, s.indexOf(':'));
            port = Integer.parseInt(s.substring(s.indexOf(':') + 1));
        }
        return new String[] {host, String.valueOf(port)};
    }

    static String httpBase(String server) {
        String[] hp = hostPort(server);
        String host = hp[0].contains(":") ? "[" + hp[0] + "]" : hp[0];
        return "http://" + host + ":" + hp[1];
    }
}
