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
            assertEquals("true", evaluate(scenario, "document.querySelector('#badgeInstalled').textContent.includes('2.1.0-test1')"));
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
}
