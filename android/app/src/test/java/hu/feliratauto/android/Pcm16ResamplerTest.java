package hu.feliratauto.android;

import java.io.ByteArrayOutputStream;
import org.junit.Test;
import static org.junit.Assert.*;

public final class Pcm16ResamplerTest {
    @Test public void outputDurationStaysExactAt44100And48000Hz() throws Exception {
        for (int rate : new int[]{44100,48000}) {
            ByteArrayOutputStream data = new ByteArrayOutputStream();
            Pcm16Resampler resampler = new Pcm16Resampler(rate, data);
            for (int frame = 0; frame < rate; frame++) resampler.accept(0.5);
            byte[] pcm = data.toByteArray();
            assertEquals(16000 * 2, pcm.length);
            for (int index = 0; index < pcm.length; index += 2) {
                int sample = (short) ((pcm[index] & 255) | ((pcm[index+1] & 255) << 8));
                assertEquals(16384, sample, 1);
            }
        }
    }
    @Test public void silenceDoesNotProduceSpuriousSpeechEnergy() throws Exception {
        ByteArrayOutputStream data = new ByteArrayOutputStream();
        Pcm16Resampler resampler = new Pcm16Resampler(48000, data);
        for (int frame = 0; frame < 48000; frame++) resampler.accept(0);
        for (byte sample : data.toByteArray()) assertEquals(0,sample);
    }
}
