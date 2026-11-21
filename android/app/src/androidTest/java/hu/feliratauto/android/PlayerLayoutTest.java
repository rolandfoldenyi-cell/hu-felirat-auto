package hu.feliratauto.android;

import android.content.pm.ActivityInfo;
import android.content.ContentValues;
import android.graphics.Bitmap;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Log;
import android.view.View;
import android.webkit.WebView;
import android.widget.FrameLayout;
import androidx.core.view.ViewCompat;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;
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
        if (Build.VERSION.SDK_INT < 29) return;
        var instrumentation = InstrumentationRegistry.getInstrumentation();
        Bitmap image = instrumentation.getUiAutomation().takeScreenshot();
        assertNotNull(image);
        // Shared test media survives Gradle uninstalling the app before artifact collection.
        ContentValues values = new ContentValues();
        values.put(MediaStore.Images.Media.DISPLAY_NAME, name + ".png");
        values.put(MediaStore.Images.Media.MIME_TYPE, "image/png");
        values.put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/HUCaptionTests");
        var resolver = instrumentation.getTargetContext().getContentResolver();
        var uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
        assertNotNull(uri);
        try (var output = resolver.openOutputStream(uri)) {
            assertTrue(image.compress(Bitmap.CompressFormat.PNG, 100, output));
        } finally { image.recycle(); }
    }
    private void awaitEdgeToEdgeWithCutout(ActivityScenario<MainActivity> scenario) throws Exception {
        long end = System.currentTimeMillis() + 30000;
        AtomicReference<Boolean> fits = new AtomicReference<>(false);
        while (System.currentTimeMillis() < end) {
            scenario.onActivity(activity -> {
                WebView browser = activity.findViewById(R.id.browser);
                View container = (View) browser.getParent();
                View decor = activity.getWindow().getDecorView();
                int[] location = new int[2]; browser.getLocationOnScreen(location);
                var insets = ViewCompat.getRootWindowInsets(container);
                var cutout = insets == null ? null : insets.getDisplayCutout();
                fits.set(container.getPaddingLeft() == 0 && container.getPaddingRight() == 0
                    && container.getPaddingTop() == 0 && container.getPaddingBottom() == 0
                    && location[0] == 0 && location[1] == 0
                    && browser.getWidth() == decor.getWidth() && browser.getHeight() == decor.getHeight()
                    && cutout != null && (cutout.getSafeInsetLeft() > 0 || cutout.getSafeInsetRight() > 0));
            });
            if (fits.get()) return;
            Thread.sleep(200);
        }
        fail("With a landscape camera cutout the WebView must cover the complete window, with zero native padding");
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
                document.querySelector('#ytPlayerHost').style.background = '#000';
                document.querySelector('#ytPlayerMount').innerHTML = '<svg width="100%" height="100%" viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid meet"><rect x="2" y="2" width="1596" height="896" fill="#1d3949" stroke="white" stroke-width="4"/><path d="M800 0V900 M0 450H1600" stroke="#5eead4" stroke-width="3"/><text x="800" y="420" fill="white" text-anchor="middle" font-size="60">Középre igazított 16:9 tesztkép</text></svg>';
                true
                """);
            scenario.onActivity(activity -> activity.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE));
            await(scenario, "innerWidth > innerHeight && document.querySelector('#playerStage').classList.contains('wide-player')");
            awaitEdgeToEdgeWithCutout(scenario);
            await(scenario, """
                (() => {
                  const stage = document.querySelector('#playerStage').getBoundingClientRect();
                  const video = document.querySelector('#ytPlayerHost').getBoundingClientRect();
                  const row = document.querySelector('#subtitleStage').getBoundingClientRect();
                  const text = document.createRange(); text.selectNodeContents(document.querySelector('#subHu'));
                  const hu = text.getBoundingClientRect();
                  const en = document.querySelector('#subOrig').getBoundingClientRect();
                  return Math.abs(stage.top) < 1 && Math.abs(stage.left) < 1 && Math.abs(stage.right - innerWidth) < 1 && Math.abs(stage.bottom - innerHeight) < 1
                    && Math.abs(video.left) < 1 && Math.abs(video.right - innerWidth) < 1
                    && Math.abs(row.left) < 1 && Math.abs(row.right - innerWidth) < 1
                    && video.height > 100 && row.height >= 56 && row.top >= video.bottom - 1
                    && row.bottom <= innerHeight + 1 && hu.top >= row.top && hu.bottom <= row.bottom
                    && hu.left >= row.left && hu.right <= row.right && en.bottom <= row.bottom
                    && !document.querySelector('#btnExitFs').hidden && window.__rotationToken === 'same-playing-page';
                })()
                """);
            screenshot("player-landscape");
            // Reproduce the asymmetric safe area from the user's screenshot in CSS too.
            evaluate(scenario, "document.documentElement.style.setProperty('--player-safe-left','80px'); document.documentElement.style.setProperty('--player-safe-right','0px'); document.documentElement.style.setProperty('--player-safe-bottom','28px'); true");
            await(scenario, """
                (() => {
                  const video = document.querySelector('#ytPlayerHost').getBoundingClientRect();
                  const row = document.querySelector('#subtitleStage').getBoundingClientRect();
                  const text = document.querySelector('#subHu').getBoundingClientRect();
                  const stage = document.querySelector('#playerStage').getBoundingClientRect();
                  return Math.abs(stage.left) < 1 && Math.abs(stage.bottom - innerHeight) < 1
                    && Math.abs(video.left) < 1 && Math.abs(video.right - innerWidth) < 1
                    && Math.abs(row.left) < 1 && Math.abs(row.right - innerWidth) < 1
                    && Math.abs((text.left + text.right) / 2 - innerWidth / 2) < 1;
                })()
                """);
            screenshot("player-asymmetric-insets");
            evaluate(scenario, "for (const side of ['left','right','bottom']) document.documentElement.style.removeProperty('--player-safe-'+side); true");
            scenario.onActivity(activity -> activity.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_REVERSE_LANDSCAPE));
            await(scenario, "screen.orientation.angle === 270");
            awaitEdgeToEdgeWithCutout(scenario);
            screenshot("player-reverse-landscape");
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
            Log.i("HUCaptionProbe", "LANDSCAPE_LAYOUT=success; captions=in-viewport; bilingual=true; back=success; videoOnlyFullscreen=redirected; pageReload=false; CUTOUT_CENTERING=success; nativePadding=0; bothLandscapeRotations=true; asymmetricCssInsets=80px/28px");
        }
    }
}
