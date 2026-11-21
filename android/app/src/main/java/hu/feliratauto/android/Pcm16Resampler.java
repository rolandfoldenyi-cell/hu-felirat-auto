// SPDX-License-Identifier: GPL-3.0-or-later
package hu.feliratauto.android;

import java.io.IOException;
import java.io.OutputStream;

/** Weighted averaging carries fractional sample boundaries across decoder buffers. */
final class Pcm16Resampler {
    private final double step;
    private final OutputStream output;
    private double weight, sum;
    Pcm16Resampler(int rate, OutputStream output) {
        if (rate < 8000 || rate > 192000) throw new IllegalArgumentException("Unsupported sample rate");
        step = rate / 16000.0; this.output = output;
    }
    void accept(double sample) throws IOException {
        double remaining = 1;
        while (remaining > 1e-9) {
            double take = Math.min(remaining, step - weight);
            sum += sample * take; weight += take; remaining -= take;
            if (weight >= step - 1e-9) {
                int value = (int) Math.max(-32768, Math.min(32767, Math.round(sum / step * 32767)));
                output.write(value & 255); output.write((value >> 8) & 255);
                sum = 0; weight = 0;
            }
        }
    }
}
