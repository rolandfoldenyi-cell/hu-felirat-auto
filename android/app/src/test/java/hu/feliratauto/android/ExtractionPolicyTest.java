package hu.feliratauto.android;

import static org.junit.Assert.*;
import org.junit.Test;

public final class ExtractionPolicyTest {
    @Test public void manualAndAutomaticEnglishBothPrecedeOtherLanguages() {
        assertTrue(CaptionExtractor.rank("en", false, "en") < CaptionExtractor.rank("en", true, "en"));
        assertTrue(CaptionExtractor.rank("en-US", true, "en") < CaptionExtractor.rank("fr", false, "en"));
        assertTrue(CaptionExtractor.rank("de", false, "de") < CaptionExtractor.rank("en", false, "de"));
    }
    @Test public void nativeDownloaderCannotFetchArbitraryOrInsecureUrls() {
        assertTrue(DeviceDownloader.permitted("https://www.youtube.com/watch?v=abcdefghijk"));
        assertTrue(DeviceDownloader.permitted("https://www.youtube.com/api/timedtext?v=abcdefghijk"));
        for (String address : new String[]{"http://www.youtube.com/", "https://youtube.com.attacker.example/",
            "https://127.0.0.1/", "https://169.254.169.254/", "https://www.youtube.com:8443/",
            "https://user:password@www.youtube.com/", "file:///etc/passwd", "not a URL"}) {
            assertFalse(address, DeviceDownloader.permitted(address));
        }
    }
}
