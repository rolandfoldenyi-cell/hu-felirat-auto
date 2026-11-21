package hu.feliratauto.android;

import android.content.pm.ActivityInfo;
import android.graphics.Bitmap;
import android.util.Log;
import android.view.View;
import android.webkit.WebView;
import android.widget.FrameLayout;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.io.File;
import java.io.FileOutputStream;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import static org.junit.Assert.*;

@RunWith(AndroidJUnit4.class)
public final class PlayerLayoutTest {
    private String evaluate(ActivityScenario<MainActivity> scenario, String script) throws Exception {
        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<String> value = new AtomicReference<>();
        scenario.onActivity(activity -> ((WebView) activity.findViewById(R.id.browser))
            .evaluateJavascript(script, result -> { value.set(result); done.countDown(); }));
        assertTrue(done.await(5, TimeUnit.SECONDS)); return value.get();
    }
    private void await(ActivityScenario<MainActivity> scenario, String script) throws Exception {
        long end = System.currentTimeMillis() + 30000;
        while (System.currentTimeMillis() < end) {
            if ("true".equals(evaluate(scenario, script))) return;
            Thread.sleep(200);
        }
        fail("Player layout condition failed: " + script);
    }
    private void screenshot(String name) throws Exception {
        var instrumentation = InstrumentationRegistry.getInstrumentation();
        Bitmap image = instrumentation.getUiAutomation().takeScreenshot();
        assertNotNull(image);
        try (var output = new FileOutputStream(new File(instrumentation.getTargetContext().getExternalFilesDir(null), name + ".png"))) {
            assertTrue(image.compress(Bitmap.CompressFormat.PNG, 100, output));
        } finally { image.recycle(); }
    }
    @Test public void rotationAndBothFullscreenRoutesKeepTheCaptionInViewWithoutReloading() throws Exception {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            scenario.onActivity(activity -> activity.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT));
            await(scenario, "Boolean(document.querySelector('#runtimeLabel')?.textContent.includes('ANDROID')) && innerHeight > innerWidth");
            evaluate(scenario, """
                window.__rotationToken = 'same-playing-page';
                document.querySelector('#playerCard').hidden = false;
                document.querySelector('#subHu').textContent = 'Ez a magyar felirat fekvő helyzetben is teljesen olvasható marad.';
                document.querySelector('#subOrig').textContent = 'The original English caption remains visible too.';
                document.querySelector('#subOrig').hidden = false;
                document.querySelector('#ytPlayerHost').style.background = '#1d3949';
                true
                """);
            scenario.onActivity(activity -> activity.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE));
            await(scenario, "innerWidth > innerHeight && document.querySelector('#playerStage').classList.contains('wide-player')");
            await(scenario, """
                (() => {
                  const stage = document.querySelector('#playerStage').getBoundingClientRect();
                  const video = document.querySelector('#ytPlayerHost').getBoundingClientRect();
                  const row = document.querySelector('#subtitleStage').getBoundingClientRect();
                  const text = document.createRange(); text.selectNodeContents(document.querySelector('#subHu'));
                  const hu = text.getBoundingClientRect();
                  const en = document.querySelector('#subOrig').getBoundingClientRect();
                  return stage.top >= 0 && stage.left >= 0 && stage.right <= innerWidth + 1 && stage.bottom <= innerHeight + 1
                    && video.height > 100 && row.height >= 56 && row.top >= video.bottom - 1
                    && row.bottom <= innerHeight + 1 && hu.top >= row.top && hu.bottom <= row.bottom
                    && hu.left >= row.left && hu.right <= row.right && en.bottom <= row.bottom
                    && !document.querySelector('#btnExitFs').hidden && window.__rotationToken === 'same-playing-page';
                })()
                """);
            screenshot("player-landscape");
            evaluate(scenario, "document.querySelector('#btnExitFs').click(); true");
            await(scenario, "!document.querySelector('#playerStage').classList.contains('wide-player')");
            evaluate(scenario, "document.querySelector('#btnFullscreen').click(); true");
            await(scenario, "document.querySelector('#playerStage').classList.contains('wide-player')");
            scenario.onActivity(MainActivity::onBackPressed);
            await(scenario, "!document.querySelector('#playerStage').classList.contains('wide-player')");

            // Reproduce a video-only fullscreen request without external YouTube access.
            scenario.onActivity(activity -> {
                WebView browser = activity.findViewById(R.id.browser);
                boolean[] rejected = {false};
                browser.getWebChromeClient().onShowCustomView(new FrameLayout(activity), () -> rejected[0] = true);
                assertTrue("Video-only fullscreen must return to the combined player", rejected[0]);
                assertEquals("The caption WebView must never be hidden", View.VISIBLE, browser.getVisibility());
            });
            await(scenario, "document.querySelector('#playerStage').classList.contains('wide-player')");
            evaluate(scenario, "document.querySelector('#btnExitFs').click(); true");
            scenario.onActivity(activity -> activity.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT));
            await(scenario, "innerHeight > innerWidth && !document.querySelector('#playerStage').classList.contains('wide-player') && window.__rotationToken === 'same-playing-page'");
            screenshot("player-portrait");
            Log.i("HUCaptionProbe", "LANDSCAPE_LAYOUT=success; captions=in-viewport; bilingual=true; back=success; videoOnlyFullscreen=redirected; pageReload=false");
        }
    }
}
