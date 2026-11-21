package hu.feliratauto.android;

import android.webkit.WebView;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import static org.junit.Assert.*;
import org.junit.AssumptionViolatedException;
import org.json.JSONObject;
import org.json.JSONTokener;
import android.util.Log;

@RunWith(AndroidJUnit4.class)
public final class AppSmokeTest {
    private String evaluate(ActivityScenario<MainActivity> scenario, String script) throws Exception {
        CountDownLatch latch = new CountDownLatch(1);
        AtomicReference<String> output = new AtomicReference<>();
        scenario.onActivity(activity -> {
            WebView browser = activity.findViewById(R.id.browser);
            assertNotNull("The app must create its WebView", browser);
            browser.evaluateJavascript(script, value -> { output.set(value); latch.countDown(); });
        });
        assertTrue("WebView JS evaluation timed out", latch.await(5, TimeUnit.SECONDS));
        return output.get();
    }

    private void awaitTrue(ActivityScenario<MainActivity> scenario, String script) throws Exception {
        long end = System.currentTimeMillis() + 30000;
        while (System.currentTimeMillis() < end) {
            if ("true".equals(evaluate(scenario, script))) return;
            Thread.sleep(250);
        }
        fail("WebView condition never became true: " + script);
    }

    @Test public void bundledAppBootsAndOnlyItsMainFrameHasNativeCapability() throws Exception {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            awaitTrue(scenario, "Boolean(document.querySelector('#urlInput') && document.querySelector('#runtimeLabel')?.textContent.includes('ANDROID'))");
            assertEquals("true", evaluate(scenario, "typeof HUCaptionNative.postMessage === 'function'"));
            assertEquals("true", evaluate(scenario, "document.querySelector('#badgeInstalled').textContent.includes('2.2.0-test1')"));
            evaluate(scenario, """
                (() => {
                  const previous = HUCaptionNative.onmessage;
                  HUCaptionNative.onmessage = event => {
                    window.__nativeProbe = JSON.parse(event.data).reason;
                    HUCaptionNative.onmessage = previous;
                  };
                  HUCaptionNative.postMessage(JSON.stringify({type:'extract',id:'999999',videoId:'invalid',lang:'en'}));
                  return true;
                })()
                """);
            awaitTrue(scenario, "window.__nativeProbe === 'invalid_request'");
            evaluate(scenario, """
                (() => {
                  const frame = document.createElement('iframe');
                  const listener = event => {
                    if (event.source !== frame.contentWindow || event.data?.probe !== 'hu-port') return;
                    window.__iframeProbe = event.data.port;
                    frame.remove(); window.removeEventListener('message', listener);
                  };
                  window.addEventListener('message', listener);
                  frame.src = 'data:text/html,' + encodeURIComponent('<script>parent.postMessage({probe:"hu-port",port:typeof HUCaptionNative},"*")</script>');
                  document.body.appendChild(frame);
                  return true;
                })()
                """);
            awaitTrue(scenario, "window.__iframeProbe === 'undefined'");
        }
    }

    @Test(timeout = 180000) public void realCaptionAndFreeTranslationProbe() throws Exception {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            awaitTrue(scenario, "Boolean(document.querySelector('#runtimeLabel')?.textContent.includes('ANDROID'))");
            evaluate(scenario, "document.querySelector('#urlInput').value='https://youtu.be/dQw4w9WgXcQ'; document.querySelector('#btnLoad').click(); true");
            long end = System.currentTimeMillis() + 140000;
            while (System.currentTimeMillis() < end) {
                String raw = evaluate(scenario, """
                    JSON.stringify({
                      text:document.querySelector('#statusText').textContent,
                      error:document.querySelector('#statusText').classList.contains('error'),
                      reason:document.querySelector('#statusText').dataset.reason,
                      cues:document.querySelectorAll('.cue-item').length,
                      ...(() => {
                        const spoken = [...document.querySelectorAll('.cue-item')].map(row => ({
                          original:row.querySelector('.cue-orig')?.textContent || '',
                          hu:row.querySelector('.cue-hu')?.textContent || ''
                        })).filter(row => /\\p{L}{2,}[^\\p{L}]+\\p{L}{2,}[^\\p{L}]+\\p{L}{2,}/u.test(row.original));
                        return { spoken:spoken.length,
                          changed:spoken.filter(row => row.hu.trim().toLowerCase() !== row.original.trim().toLowerCase()).length,
                          hungarian:spoken.filter(row => /[áéíóöőúüű]/i.test(row.hu)).length };
                      })()
                    })
                    """);
                JSONObject status = new JSONObject((String) new JSONTokener(raw).nextValue());
                if (status.getBoolean("error")) {
                    String reason = status.optString("reason");
                    Log.i("HUCaptionProbe", "OUTCOME=" + reason + "; videoId=dQw4w9WgXcQ; network=GitHub-emulator");
                    if (reason.equals("youtube_blocked") || reason.equals("network_error") || reason.equals("timeout") || reason.equals("unavailable")) {
                        throw new AssumptionViolatedException("External network probe could not complete: " + reason + ". Phone-network validation still required.");
                    }
                    fail("Real pipeline failed: " + status.getString("text"));
                }
                if (status.getString("text").startsWith("Kész")) {
                    assertTrue("The real extraction must return timed cues", status.getInt("cues") > 1);
                    assertTrue("The probe must include real English speech rather than only music labels", status.getInt("spoken") >= 5);
                    assertEquals("All eligible spoken lines must change; unchanged music labels are valid", status.getInt("spoken"), status.getInt("changed"));
                    assertTrue("Hungarian output should include Hungarian accented words", status.getInt("hungarian") > 0);
                    Log.i("HUCaptionProbe", "OUTCOME=success; videoId=dQw4w9WgXcQ; cues=" + status.getInt("cues")
                        + "; spoken=" + status.getInt("spoken") + "; translated=" + status.getInt("changed") + "; network=GitHub-emulator");
                    return;
                }
                Thread.sleep(500);
            }
            fail("The real caption/translation probe did not finish within its time limit");
        }
    }
}
