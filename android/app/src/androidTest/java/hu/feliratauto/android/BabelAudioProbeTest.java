package hu.feliratauto.android;

import android.util.Log;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.schabi.newpipe.extractor.MediaFormat;
import org.schabi.newpipe.extractor.NewPipe;
import org.schabi.newpipe.extractor.localization.Localization;
import org.schabi.newpipe.extractor.localization.ContentCountry;
import org.schabi.newpipe.extractor.stream.AudioStream;
import java.net.URL;
import javax.net.ssl.HttpsURLConnection;
import static org.junit.Assert.*;

@RunWith(AndroidJUnit4.class)
@org.junit.Ignore("Manual source probe: YouTube currently blocks this server IP; no-captions confirmed in the public player")
public final class BabelAudioProbeTest {
    @Test(timeout = 120000) public void inspectActualUserVideoAudioAvailability() throws Exception {
        DeviceDownloader downloader = new DeviceDownloader();
        NewPipe.init(downloader, new Localization("en", "GB"), new ContentCountry("GB"));
        var extractor = NewPipe.getService("YouTube").getStreamExtractor("https://www.youtube.com/watch?v=RecF4T7KquQ");
        extractor.fetchPage();
        var captions = extractor.getSubtitles(MediaFormat.VTT);
        var streams = extractor.getAudioStreams();
        Log.i("HUBabelProbe", "videoId=RecF4T7KquQ; captions=" + captions.size() + "; audioStreams=" + streams.size());
        assertFalse("No direct audio stream is available for local transcription", streams.isEmpty());
        AudioStream chosen = streams.stream().filter(stream -> stream.isUrl() && stream.getFormat() == MediaFormat.M4A).findFirst()
            .orElse(streams.get(0));
        assertTrue("Audio address must be a permitted public HTTPS YouTube address", DeviceDownloader.permitted(chosen.getContent()));
        HttpsURLConnection connection = (HttpsURLConnection) new URL(chosen.getContent()).openConnection();
        try {
            connection.setConnectTimeout(15000); connection.setReadTimeout(15000);
            connection.setRequestProperty("Range", "bytes=0-4095");
            connection.setRequestProperty("User-Agent", "Mozilla/5.0");
            int http = connection.getResponseCode();
            Log.i("HUBabelProbe", "audioFormat=" + chosen.getFormat() + "; http=" + http + "; mime=" + connection.getContentType());
            assertTrue("Audio download did not return usable bytes: HTTP " + http, http == 200 || http == 206);
            try (var input = connection.getInputStream()) {
                byte[] sample = input.readNBytes(512);
                Log.i("HUBabelProbe", "audioSampleBytes=" + sample.length);
                assertTrue(sample.length > 0);
            }
        } finally { connection.disconnect(); }
    }
}
