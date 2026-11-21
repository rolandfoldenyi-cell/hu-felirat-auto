// SPDX-License-Identifier: GPL-3.0-or-later
package hu.feliratauto.android;

import android.content.Context;
import android.media.AudioFormat;
import android.media.MediaCodec;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.*;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;

/** Offline speech recognition. No microphone, account, API key or credit provider. */
final class LocalSpeech {
    interface Progress { void update(String stage, int percent); }
    interface NativeProgress { void percent(int percent); }
    private static volatile boolean loaded;
    private static synchronized void load() {
        if (!loaded) { System.loadLibrary("hu_whisper"); loaded = true; }
    }
    static void cancel() { if (loaded) cancelNative(); }
    private static native void cancelNative();
    private static native long beginNative();
    private static native byte[] transcribeNative(String model, String vadModel, String pcm, int threads, long request, NativeProgress listener);

    static String transcribe(Context context, File audio, Progress progress) throws Exception {
        progress.update("Beszédfelismerő előkészítése", 0);
        load();
        interrupted();
        long request = beginNative();
        String model = model(context, "whisper");
        String vad = model(context, "vad");
        File pcm = File.createTempFile("huf-speech-", ".pcm", context.getCacheDir());
        try {
            progress.update("Hangsáv feldolgozása", 0);
            decode(audio, pcm, progress);
            interrupted();
            progress.update("Angol beszéd felismerése a telefonon", 0);
            byte[] output = transcribeNative(model, vad, pcm.getAbsolutePath(),
                Math.max(1, Math.min(4, Runtime.getRuntime().availableProcessors())), request,
                percent -> progress.update("Angol beszéd felismerése a telefonon", percent));
            interrupted();
            String vtt = new String(output, StandardCharsets.UTF_8);
            if (!vtt.contains("-->")) throw new CaptionExtractor.CaptionFailure("no_speech", "A hangban nem találtam felismerhető angol beszédet. A képre írt szöveget ez a beszédfelismerő nem olvassa le.");
            return vtt;
        } finally { pcm.delete(); }
    }

    private static String model(Context context, String kind) throws Exception {
        JSONArray entries;
        try (InputStream input = context.getAssets().open("models/manifest.json")) {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            byte[] chunk = new byte[4096]; int count;
            while ((count = input.read(chunk)) != -1) { if (bytes.size() + count > 65536) throw new IOException("Túl nagy modell-leírás"); bytes.write(chunk, 0, count); }
            entries = new JSONObject(new String(bytes.toByteArray(), StandardCharsets.UTF_8)).getJSONArray("models");
        }
        for (int index = 0; index < entries.length(); index++) {
            JSONObject entry = entries.getJSONObject(index);
            if (!entry.getString("kind").equals(kind)) continue;
            String name = entry.getString("file");
            if (!name.matches("[A-Za-z0-9._-]+")) throw new IOException("Hibás modellnév");
            File directory = new File(context.getFilesDir(), "speech-models");
            if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("A beszédfelismerő nem tárolható");
            File destination = new File(directory, name);
            if (destination.isFile() && destination.length() == entry.getLong("bytes")) return destination.getAbsolutePath();
            File temporary = File.createTempFile("model-", ".tmp", directory);
            try {
                MessageDigest digest = MessageDigest.getInstance("SHA-256");
                try (InputStream input = context.getAssets().open("models/" + name); OutputStream output = new FileOutputStream(temporary)) {
                    byte[] buffer = new byte[65536]; int count;
                    while ((count = input.read(buffer)) != -1) { interrupted(); digest.update(buffer, 0, count); output.write(buffer, 0, count); }
                }
                StringBuilder sha = new StringBuilder();
                for (byte value : digest.digest()) sha.append(String.format(Locale.ROOT, "%02x", value & 255));
                if (temporary.length() != entry.getLong("bytes") || !sha.toString().equals(entry.getString("sha256"))) throw new IOException("A beszédfelismerő modell ellenőrzése sikertelen");
                if (destination.exists() && !destination.delete()) throw new IOException("A modell nem frissíthető");
                if (!temporary.renameTo(destination)) throw new IOException("A modell nem menthető");
                return destination.getAbsolutePath();
            } finally { temporary.delete(); }
        }
        throw new IOException("Hiányzik a beszédfelismerő modell: " + kind);
    }

    private static void decode(File source, File target, Progress progress) throws Exception {
        MediaExtractor extractor = new MediaExtractor();
        MediaCodec codec = null;
        try (OutputStream output = new BufferedOutputStream(new FileOutputStream(target), 65536)) {
            extractor.setDataSource(source.getAbsolutePath());
            MediaFormat format = null; int selected = -1;
            for (int index = 0; index < extractor.getTrackCount(); index++) {
                MediaFormat candidate = extractor.getTrackFormat(index);
                if (candidate.getString(MediaFormat.KEY_MIME).startsWith("audio/")) { format = candidate; selected = index; break; }
            }
            if (format == null) throw new IOException("Nincs dekódolható hangsáv");
            extractor.selectTrack(selected);
            long duration = format.containsKey(MediaFormat.KEY_DURATION) ? format.getLong(MediaFormat.KEY_DURATION) : 0;
            if (duration > 3600L * 1000000) throw new CaptionExtractor.CaptionFailure("audio_too_long", "A telefonos beszédfelismerés ebben a tesztverzióban legfeljebb 60 perces videót dolgoz fel.");
            codec = MediaCodec.createDecoderByType(format.getString(MediaFormat.KEY_MIME));
            format.setInteger(MediaFormat.KEY_PCM_ENCODING, AudioFormat.ENCODING_PCM_16BIT);
            codec.configure(format, null, null, 0); codec.start();
            Pcm16Resampler writer = null;
            int channels = format.getInteger(MediaFormat.KEY_CHANNEL_COUNT);
            int encoding = AudioFormat.ENCODING_PCM_16BIT;
            int sampleRate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE);
            boolean inputDone = false, outputDone = false;
            MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
            long lastProgressAt = 0;
            long lastOutputAt = System.nanoTime();
            while (!outputDone) {
                interrupted();
                if (System.nanoTime() - lastOutputAt > 30_000_000_000L) throw new IOException("A hangdekódolás nem válaszol");
                if (!inputDone) {
                    int inputIndex = codec.dequeueInputBuffer(10000);
                    if (inputIndex >= 0) {
                        ByteBuffer buffer = codec.getInputBuffer(inputIndex);
                        int size = extractor.readSampleData(buffer, 0);
                        if (size < 0) { codec.queueInputBuffer(inputIndex, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM); inputDone = true; }
                        else { codec.queueInputBuffer(inputIndex, 0, size, extractor.getSampleTime(), 0); extractor.advance(); }
                    }
                }
                int index = codec.dequeueOutputBuffer(info, 10000);
                if (index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    MediaFormat current = codec.getOutputFormat();
                    channels = current.getInteger(MediaFormat.KEY_CHANNEL_COUNT);
                    sampleRate = current.getInteger(MediaFormat.KEY_SAMPLE_RATE);
                    encoding = current.containsKey(MediaFormat.KEY_PCM_ENCODING) ? current.getInteger(MediaFormat.KEY_PCM_ENCODING) : AudioFormat.ENCODING_PCM_16BIT;
                    writer = new Pcm16Resampler(sampleRate, output);
                } else if (index >= 0) {
                    lastOutputAt = System.nanoTime();
                    if (writer == null) writer = new Pcm16Resampler(sampleRate, output);
                    if (encoding != AudioFormat.ENCODING_PCM_16BIT && encoding != AudioFormat.ENCODING_PCM_FLOAT) throw new IOException("Nem támogatott hangmintakódolás");
                    ByteBuffer buffer = codec.getOutputBuffer(index).order(ByteOrder.LITTLE_ENDIAN);
                    buffer.position(info.offset); buffer.limit(info.offset + info.size);
                    int bytes = encoding == AudioFormat.ENCODING_PCM_FLOAT ? 4 : 2;
                    while (buffer.remaining() >= channels * bytes) {
                        double sum = 0;
                        for (int channel = 0; channel < channels; channel++) sum += encoding == AudioFormat.ENCODING_PCM_FLOAT ? buffer.getFloat() : buffer.getShort() / 32768.0;
                        writer.accept(sum / channels);
                    }
                    if (duration > 0 && System.nanoTime() - lastProgressAt > 500_000_000L) {
                        progress.update("Hangsáv feldolgozása", (int) Math.min(99, info.presentationTimeUs * 100 / duration));
                        lastProgressAt = System.nanoTime();
                    }
                    outputDone = (info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0;
                    codec.releaseOutputBuffer(index, false);
                }
            }
            output.flush();
            if (target.length() < 16000) throw new CaptionExtractor.CaptionFailure("no_speech", "A hangsáv túl rövid a beszédfelismeréshez.");
        } finally {
            if (codec != null) { try { codec.stop(); } catch (Exception ignored) {} codec.release(); }
            extractor.release();
        }
    }

    static void interrupted() throws InterruptedIOException {
        if (Thread.currentThread().isInterrupted()) throw new InterruptedIOException("Megszakított beszédfelismerés");
    }
}
