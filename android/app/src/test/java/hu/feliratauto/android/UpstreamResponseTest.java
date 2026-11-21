package hu.feliratauto.android;
import org.junit.Test;
import static org.junit.Assert.*;

public final class UpstreamResponseTest {
    @Test public void onlyTheKnownHtmlInsteadOfJsonResponseIsClassifiedAsUpstreamFormatFailure() {
        assertTrue(MainActivity.isUnexpectedUpstreamHtml("ParsingException", "Got HTML document, expected JSON response (latest url was [URL])"));
        assertFalse(MainActivity.isUnexpectedUpstreamHtml("ParsingException", "Could not find subtitle renderer in JSON"));
        assertFalse(MainActivity.isUnexpectedUpstreamHtml("ParsingException", "Unexpected end of JSON"));
        assertFalse(MainActivity.isUnexpectedUpstreamHtml("IOException", "Got HTML document, expected JSON response"));
    }
}
