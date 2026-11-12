package com.firstmate.app;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Base64;

/**
 * A small RFC 6455 WebSocket client: text and binary frames, ping/pong, close.
 * Enough for one long-lived connection to the dispatcher, with no libraries.
 */
final class MiniWebSocket {
    interface Listener {
        void onText(String text);

        default void onBinary(byte[] data) {}
    }

    private static final String GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    private final SecureRandom random = new SecureRandom();
    private final Object writeLock = new Object();
    private Socket socket;
    private InputStream in;
    private OutputStream out;
    private volatile boolean open;
    /** Close code the server sent, or 0. 4401 means the key was refused. */
    volatile int closeCode;

    /** Connects and completes the handshake. Throws on failure. */
    void connect(String host, int port, String path, int timeoutMs) throws IOException {
        socket = new Socket();
        socket.connect(new InetSocketAddress(host, port), timeoutMs);
        socket.setTcpNoDelay(true);
        // The server pings every 20 s; silence for longer than this means the link is dead.
        socket.setSoTimeout(65_000);
        in = new BufferedInputStream(socket.getInputStream(), 16 * 1024);
        out = socket.getOutputStream();

        byte[] nonce = new byte[16];
        random.nextBytes(nonce);
        String key = Base64.getEncoder().encodeToString(nonce);
        String hostHeader = (host.contains(":") ? "[" + host + "]" : host) + ":" + port;
        String request = "GET " + path + " HTTP/1.1\r\n"
                + "Host: " + hostHeader + "\r\n"
                + "Upgrade: websocket\r\n"
                + "Connection: Upgrade\r\n"
                + "Sec-WebSocket-Key: " + key + "\r\n"
                + "Sec-WebSocket-Version: 13\r\n"
                + "User-Agent: firstmate-android\r\n\r\n";
        out.write(request.getBytes(StandardCharsets.US_ASCII));
        out.flush();

        String status = readLine();
        if (status == null || !status.contains(" 101")) {
            close();
            throw new IOException("handshake refused: " + status);
        }
        String accept = null;
        for (String line = readLine(); line != null && !line.isEmpty(); line = readLine()) {
            int colon = line.indexOf(':');
            if (colon > 0 && line.substring(0, colon).trim().equalsIgnoreCase("Sec-WebSocket-Accept")) {
                accept = line.substring(colon + 1).trim();
            }
        }
        String expected = expectedAccept(key);
        if (accept == null || !accept.equals(expected)) {
            close();
            throw new IOException("bad handshake accept");
        }
        open = true;
    }

    boolean isOpen() {
        return open;
    }

    /** Reads frames until the connection closes. Returns normally on a clean close. */
    void readLoop(Listener listener) throws IOException {
        ByteArrayOutputStream message = new ByteArrayOutputStream();
        int messageOpcode = -1;
        while (open) {
            int b0 = in.read();
            if (b0 < 0) throw new EOFException("closed");
            int b1 = readByte();
            boolean fin = (b0 & 0x80) != 0;
            int opcode = b0 & 0x0f;
            boolean masked = (b1 & 0x80) != 0;
            long len = b1 & 0x7f;
            if (len == 126) {
                len = ((long) readByte() << 8) | readByte();
            } else if (len == 127) {
                len = 0;
                for (int i = 0; i < 8; i++) len = (len << 8) | readByte();
            }
            if (len > (8 << 20)) throw new IOException("frame too large");
            byte[] mask = null;
            if (masked) {
                mask = new byte[4];
                readFully(mask);
            }
            byte[] payload = new byte[(int) len];
            readFully(payload);
            if (mask != null) for (int i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];

            switch (opcode) {
                case 0x0: // continuation
                case 0x1: // text
                case 0x2: // binary
                    if (opcode != 0x0) {
                        message.reset();
                        messageOpcode = opcode;
                    }
                    message.write(payload, 0, payload.length);
                    if (fin) {
                        if (messageOpcode == 0x1) listener.onText(new String(message.toByteArray(), StandardCharsets.UTF_8));
                        else if (messageOpcode == 0x2) listener.onBinary(message.toByteArray());
                        message.reset();
                    }
                    break;
                case 0x8: // close
                    if (payload.length >= 2) closeCode = ((payload[0] & 0xff) << 8) | (payload[1] & 0xff);
                    try {
                        sendFrame(0x8, payload, 0, Math.min(payload.length, 2));
                    } catch (IOException ignored) {
                        // closing anyway
                    }
                    close();
                    return;
                case 0x9: // ping
                    sendFrame(0xA, payload, 0, payload.length);
                    break;
                default: // pong and anything else
                    break;
            }
        }
    }

    void sendText(String text) throws IOException {
        byte[] data = text.getBytes(StandardCharsets.UTF_8);
        sendFrame(0x1, data, 0, data.length);
    }

    void sendBinary(byte[] data, int off, int len) throws IOException {
        sendFrame(0x2, data, off, len);
    }

    void close() {
        open = false;
        try {
            if (socket != null) socket.close();
        } catch (IOException ignored) {
            // already closed
        }
    }

    private void sendFrame(int opcode, byte[] data, int off, int len) throws IOException {
        if (!open && opcode != 0x8) throw new IOException("not open");
        byte[] head = new byte[14];
        int n = 0;
        head[n++] = (byte) (0x80 | opcode);
        if (len < 126) {
            head[n++] = (byte) (0x80 | len);
        } else if (len < 65536) {
            head[n++] = (byte) (0x80 | 126);
            head[n++] = (byte) (len >>> 8);
            head[n++] = (byte) len;
        } else {
            head[n++] = (byte) (0x80 | 127);
            for (int i = 7; i >= 0; i--) head[n++] = (byte) (((long) len) >>> (8 * i));
        }
        byte[] mask = new byte[4];
        random.nextBytes(mask);
        System.arraycopy(mask, 0, head, n, 4);
        n += 4;
        byte[] body = new byte[len];
        for (int i = 0; i < len; i++) body[i] = (byte) (data[off + i] ^ mask[i & 3]);
        synchronized (writeLock) {
            out.write(head, 0, n);
            out.write(body);
            out.flush();
        }
    }

    private int readByte() throws IOException {
        int b = in.read();
        if (b < 0) throw new EOFException("closed");
        return b;
    }

    private void readFully(byte[] buf) throws IOException {
        int read = 0;
        while (read < buf.length) {
            int r = in.read(buf, read, buf.length - read);
            if (r < 0) throw new EOFException("closed");
            read += r;
        }
    }

    private String readLine() throws IOException {
        StringBuilder sb = new StringBuilder();
        while (true) {
            int c = in.read();
            if (c < 0) return sb.length() == 0 ? null : sb.toString();
            if (c == '\n') break;
            if (c != '\r') sb.append((char) c);
            if (sb.length() > 8192) throw new IOException("header too long");
        }
        return sb.toString();
    }

    private static String expectedAccept(String key) {
        try {
            MessageDigest sha1 = MessageDigest.getInstance("SHA-1");
            byte[] digest = sha1.digest((key + GUID).getBytes(StandardCharsets.US_ASCII));
            return Base64.getEncoder().encodeToString(digest);
        } catch (Exception e) {
            return "";
        }
    }
}
