// SPDX-License-Identifier: GPL-3.0-or-later
package hu.feliratauto.android;

import android.content.Context;
import org.json.JSONObject;
import org.json.JSONArray;
import org.schabi.newpipe.extractor.MediaFormat;
import org.schabi.newpipe.extractor.stream.StreamExtractor;
import org.schabi.newpipe.extractor.stream.AudioStream;
import java.io.*;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Comparator;
import javax.net.ssl.HttpsURLConnection;

final class SpeechSource {
    static JSONObject cached(Context context, String videoId) {
        File file = new File(context.getCacheDir(), "speech-" + videoId + ".json");
        if (!file.isFile() || file.length() > 2 * 1024 * 1024 || System.currentTimeMillis() - file.lastModified() > 7L * 86400000) return null;
        try (InputStream input = new FileInputStream(file)) {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192]; int count;
            while ((count = input.read(buffer)) != -1) bytes.write(buffer, 0, count);
            JSONObject result = new JSONObject(new String(bytes.toByteArray(), StandardCharsets.UTF_8));
            if (result.optString("videoId").equals(videoId) && result.optString("vtt").contains("-->")) return result.put("nativeVersion", BuildConfig.VERSION_NAME);
        } catch (Exception ignored) {}
        return null;
    }

    static JSONObject create(Context context, StreamExtractor extractor, String videoId, LocalSpeech.Progress progress) throws Exception {
        progress.update("Nincs YouTube-felirat; hangsáv lekérése", 0);
        if (extractor.getLength() > 3600) throw new CaptionExtractor.CaptionFailure("audio_too_long", "A telefonos beszédfelismerés ebben a tesztverzióban legfeljebb 60 perces videót dolgoz fel.");
        var streams = extractor.getAudioStreams();
        AudioStream audio = streams.stream().filter(stream -> stream.isUrl())
            .min(Comparator.comparingInt(stream -> (stream.getFormat() == MediaFormat.M4A ? 0 : 100000) + Math.max(0, stream.getAverageBitrate())))
            .orElseThrow(() -> new CaptionExtractor.CaptionFailure("audio_unavailable", "Nincs YouTube-felirat, és a hangsávhoz sem sikerült hozzáférni."));
        File source = File.createTempFile("huf-audio-", ".media", context.getCacheDir());
        try {
            download(audio.getContent(), source, progress);
            String vtt;
            try { vtt = LocalSpeech.transcribe(context, source, progress); }
            catch (CaptionExtractor.CaptionFailure known) { throw known; }
            catch (InterruptedIOException interrupted) { throw interrupted; }
            catch (Exception error) {
                CaptionExtractor.CaptionFailure failure = new CaptionExtractor.CaptionFailure("speech_failed", "A telefonos beszédfelismerés nem sikerült. Ellenőrizd a szabad tárhelyet, majd próbáld újra.");
                failure.initCause(error); throw failure;
            }
            JSONObject track = new JSONObject().put("langCode", "en").put("langName", "Angol – a telefonon felismert beszéd").put("isAuto", true);
            JSONObject result = new JSONObject().put("videoId", videoId).put("title", extractor.getName()).put("source", "android_asr")
                .put("selectedTrack", track).put("tracks", new JSONArray().put(track)).put("vtt", vtt).put("nativeVersion", BuildConfig.VERSION_NAME);
            try (OutputStream output = new FileOutputStream(new File(context.getCacheDir(), "speech-" + videoId + ".json"))) {
                output.write(result.toString().getBytes(StandardCharsets.UTF_8));
            } catch (IOException ignored) { /* A full cache does not discard a completed transcript. */ }
            return result;
        } finally { source.delete(); }
    }

    private static void download(String address, File destination, LocalSpeech.Progress progress) throws Exception {
        for (int redirect = 0; redirect < 6; redirect++) {
            LocalSpeech.interrupted();
            if (!DeviceDownloader.permitted(address)) throw new IOException("Nem engedélyezett hangsávcím");
            HttpsURLConnection connection = (HttpsURLConnection) new URL(address).openConnection();
            try {
                connection.setInstanceFollowRedirects(false); connection.setConnectTimeout(15000); connection.setReadTimeout(20000);
                connection.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36");
                int status = connection.getResponseCode();
                if (status == 301 || status == 302 || status == 303 || status == 307 || status == 308) {
                    String location = connection.getHeaderField("Location");
                    if (location == null) throw new IOException("Hiányos hangsáv-átirányítás");
                    address = URI.create(address).resolve(location).toString(); continue;
                }
                if (status != 200 && status != 206) throw new CaptionExtractor.CaptionFailure("audio_unavailable", "Nincs YouTube-felirat, és a YouTube a hangsáv letöltését sem engedte (HTTP " + status + ").");
                String type = String.valueOf(connection.getContentType());
                if (type.contains("text/") || type.contains("json")) throw new CaptionExtractor.CaptionFailure("audio_unavailable", "A YouTube nem adott feldolgozható hangsávot ehhez a videóhoz.");
                long length = connection.getContentLengthLong(), size = 0, lastUpdate = 0;
                try (InputStream input = connection.getInputStream(); OutputStream output = new BufferedOutputStream(new FileOutputStream(destination))) {
                    byte[] buffer = new byte[65536]; int count;
                    while ((count = input.read(buffer)) != -1) {
                        LocalSpeech.interrupted(); size += count;
                        if (size > 128L * 1024 * 1024) throw new CaptionExtractor.CaptionFailure("audio_too_large", "A hangsáv túl nagy a telefonos feldolgozáshoz.");
                        output.write(buffer, 0, count);
                        if (System.nanoTime() - lastUpdate > 500000000L) { progress.update("Hangsáv letöltése", length > 0 ? (int) Math.min(99, size * 100 / length) : 0); lastUpdate = System.nanoTime(); }
                    }
                }
                if (size == 0) throw new IOException("Üres hangsáv érkezett");
                return;
            } finally { connection.disconnect(); }
        }
        throw new IOException("Túl sok hangsáv-átirányítás");
    }
}
