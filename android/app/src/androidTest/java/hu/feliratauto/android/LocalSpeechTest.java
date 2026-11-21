package hu.feliratauto.android;

import android.content.Context;
import android.util.Log;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.io.*;
import java.util.concurrent.atomic.AtomicInteger;
import static org.junit.Assert.*;

@RunWith(AndroidJUnit4.class)
public final class LocalSpeechTest {
    @Test(timeout=240000) public void compressedAudioBecomesTimedEnglishWithoutAnyCloudProvider() throws Exception {
        var instrumentation = InstrumentationRegistry.getInstrumentation();
        Context app = instrumentation.getTargetContext();
        File sample = File.createTempFile("speech-test-", ".m4a", app.getCacheDir());
        try {
            try (InputStream input = instrumentation.getContext().getAssets().open("speech-sample.m4a"); OutputStream output = new FileOutputStream(sample)) {
                byte[] buffer = new byte[8192]; int count;
                while ((count=input.read(buffer))!=-1) output.write(buffer,0,count);
            }
            AtomicInteger updates = new AtomicInteger();
            String vtt = LocalSpeech.transcribe(app, sample, (stage,percent)->updates.incrementAndGet());
            assertTrue(vtt.startsWith("WEBVTT")); assertTrue(vtt.contains("-->"));
            assertTrue("The real English speech must be recognized",vtt.toLowerCase(java.util.Locale.ROOT).contains("country"));
            assertTrue(updates.get()>2);
            Log.i("HUCaptionProbe","OFFLINE_SPEECH=success; format=AAC; timedVttBytes="+vtt.length());
        } finally { sample.delete(); }
    }
}
