// SPDX-License-Identifier: GPL-3.0-or-later
package hu.feliratauto.android;

import org.schabi.newpipe.extractor.downloader.Downloader;
import org.schabi.newpipe.extractor.downloader.Request;
import org.schabi.newpipe.extractor.downloader.Response;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import javax.net.ssl.HttpsURLConnection;

/** Public YouTube metadata only; independent of WebView cookies and account sessions. */
final class DeviceDownloader extends Downloader {
    private static final int MAX_BYTES = 16 * 1024 * 1024;

    static boolean permitted(String address) {
        try {
            URI uri = URI.create(address);
            String host = uri.getHost();
            return "https".equals(uri.getScheme()) && uri.getUserInfo() == null
                && (uri.getPort() == -1 || uri.getPort() == 443) && host != null
                && (host.equals("youtube.com") || host.endsWith(".youtube.com")
                    || host.equals("youtube-nocookie.com") || host.endsWith(".youtube-nocookie.com")
                    || host.equals("youtubei.googleapis.com") || host.equals("www.googleapis.com")
                    || host.endsWith(".googlevideo.com"));
        } catch (IllegalArgumentException e) { return false; }
    }

    @Override public Response execute(Request request) throws IOException {
        String address = request.url();
        String method = request.httpMethod();
        byte[] body = request.dataToSend();
        for (int redirect = 0; redirect <= 5; redirect++) {
            if (Thread.currentThread().isInterrupted()) throw new IOException("Megszakított kérés");
            if (!permitted(address)) throw new IOException("Nem engedélyezett letöltési cím");
            HttpsURLConnection connection = (HttpsURLConnection) new URL(address).openConnection();
            try {
                connection.setInstanceFollowRedirects(false);
                connection.setConnectTimeout(12000);
                connection.setReadTimeout(18000);
                connection.setRequestMethod(method);
                connection.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36");
                for (Map.Entry<String, List<String>> header : request.headers().entrySet()) {
                    if (header.getValue() == null) continue;
                    connection.setRequestProperty(header.getKey(), String.join(", ", header.getValue()));
                }
                if (body != null && !method.equals("GET") && !method.equals("HEAD")) {
                    connection.setDoOutput(true);
                    try (var output = connection.getOutputStream()) { output.write(body); }
                }
                int status = connection.getResponseCode();
                if (status == 301 || status == 302 || status == 303 || status == 307 || status == 308) {
                    String location = connection.getHeaderField("Location");
                    if (location == null) throw new IOException("Hiányos átirányítás");
                    address = URI.create(address).resolve(location).toString();
                    if (status == 303 || ((status == 301 || status == 302) && method.equals("POST"))) {
                        method = "GET"; body = null;
                    }
                    continue;
                }
                InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
                String text = "";
                if (stream != null) try (InputStream input = stream; ByteArrayOutputStream bytes = new ByteArrayOutputStream()) {
                    byte[] buffer = new byte[8192];
                    int count;
                    while ((count = input.read(buffer)) != -1) {
                        if (Thread.currentThread().isInterrupted()) throw new IOException("Megszakított kérés");
                        if (bytes.size() + count > MAX_BYTES) throw new IOException("Túl nagy szerverválasz");
                        bytes.write(buffer, 0, count);
                    }
                    text = new String(bytes.toByteArray(), StandardCharsets.UTF_8);
                }
                return new Response(status, connection.getResponseMessage(), connection.getHeaderFields(), text, address);
            } finally { connection.disconnect(); }
        }
        throw new IOException("Túl sok átirányítás");
    }
}
