// SPDX-License-Identifier: GPL-3.0-or-later
package hu.feliratauto.android;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.view.WindowManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import org.json.JSONObject;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.Future;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

public final class MainActivity extends Activity {
    private static final String HOST = "hu-felirat-auto-seven.vercel.app";
    private static final String ORIGIN = "https://" + HOST;
    private static final Set<String> ASSETS = Set.of("index.html", "app.js", "styles.css", "manifest.json",
        "subtitle-files.js", "translation-priority.js", "native-captions.js", "timed-translation.js", "player-layout.js", "sentence-cues.js", "android-notices.html",
        "icons/icon-192.png", "icons/icon-512.png", "icons/icon-maskable-512.png", "licenses/GPL-3.0.txt", "licenses/whisper-MIT.txt", "licenses/Whisper-models-MIT.txt", "licenses/Silero-VAD-MIT.txt");
    private final ThreadPoolExecutor executor = new ThreadPoolExecutor(1, 1, 0L, TimeUnit.SECONDS, new ArrayBlockingQueue<>(1));
    private CaptionExtractor extractor;
    private Future<?> extraction;
    private String activeId = "";
    private int pageEpoch;
    private WebView webView;
    private FrameLayout root;
    private boolean playerExpanded;
    private boolean playerOrientationLocked;
    private ValueCallback<Uri[]> fileCallback;

    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        getWindow().setStatusBarColor(Color.TRANSPARENT);
        getWindow().setNavigationBarColor(Color.TRANSPARENT);
        if (android.os.Build.VERSION.SDK_INT >= 28) {
            var attributes = getWindow().getAttributes();
            attributes.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            getWindow().setAttributes(attributes);
        }
        if (android.os.Build.VERSION.SDK_INT >= 29) getWindow().setNavigationBarContrastEnforced(false);
        root = new FrameLayout(this);
        root.setBackgroundColor(Color.rgb(10, 18, 24));
        ViewCompat.setOnApplyWindowInsetsListener(root, (view, insets) -> {
            // In player mode the WebView fills the window. Only text/buttons use safe areas.
            // In normal mode the native container owns these insets and consumes them once.
            Insets safe = playerExpanded ? Insets.NONE
                : insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            view.setPadding(safe.left, safe.top, safe.right, safe.bottom);
            return playerExpanded ? insets : WindowInsetsCompat.CONSUMED;
        });
        setContentView(root);
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            new AlertDialog.Builder(this).setTitle("WebView-frissítés szükséges")
                .setMessage("Frissítsd az Android System WebView és a Chrome alkalmazást, majd nyisd meg újra a HU Felirat Autót.")
                .setPositiveButton("Rendben", (dialog, which) -> finish()).setCancelable(false).show();
            return;
        }
        extractor = new CaptionExtractor(this);
        webView = new WebView(this);
        webView.setId(R.id.browser);
        root.addView(webView, new FrameLayout.LayoutParams(-1, -1));
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true); // Only user-selected fallback subtitle files.
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setUserAgentString(settings.getUserAgentString() + " HUFeliratAuto/" + BuildConfig.VERSION_NAME);

        WebViewAssetLoader assets = new WebViewAssetLoader.Builder().setDomain(HOST).addPathHandler("/", path -> {
            String name = path.isEmpty() ? "index.html" : path;
            if (!ASSETS.contains(name)) return null; // /api stays on the existing HTTPS backend.
            try {
                String mime = name.endsWith(".js") ? "application/javascript" : name.endsWith(".css") ? "text/css"
                    : name.endsWith(".png") ? "image/png" : name.endsWith(".json") ? "application/json"
                    : name.endsWith(".txt") ? "text/plain" : "text/html";
                return new WebResourceResponse(mime, "UTF-8", 200, "OK", Map.of("Cache-Control", "no-store"), getAssets().open("site/" + name));
            } catch (IOException e) {
                return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", Map.of(), new ByteArrayInputStream(new byte[0]));
            }
        }).build();
        webView.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return assets.shouldInterceptRequest(request.getUrl());
            }
            @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap icon) {
                pageEpoch++;
                cancelExtraction();
                setPlayerLayout(false, false);
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (!request.isForMainFrame()) return false;
                Uri uri = request.getUrl();
                if (ORIGIN.equals(uri.getScheme() + "://" + uri.getHost()) && (uri.getPort() == -1 || uri.getPort() == 443)) return false;
                if (request.hasGesture() && "https".equals(uri.getScheme())) {
                    try { startActivity(new Intent(Intent.ACTION_VIEW, uri)); } catch (Exception ignored) {}
                }
                return true;
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override public void onShowCustomView(View view, CustomViewCallback callback) {
                // A video-only custom view drops the app's Hungarian caption row.
                // Keep the original WebView and expand the complete player instead.
                callback.onCustomViewHidden();
                webView.post(() -> webView.evaluateJavascript("window.dispatchEvent(new Event('hu-enter-player'))", null));
            }
            @Override public void onHideCustomView() { /* The app owns the complete player layout. */ }
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                try { startActivityForResult(params.createIntent(), 101); return true; }
                catch (Exception e) { fileCallback = null; return false; }
            }
        });

        // AndroidX installs the port only in this exact origin; the iframe is also rejected explicitly.
        WebViewCompat.addWebMessageListener(webView, "HUCaptionNative", Set.of(ORIGIN), (view, message, sourceOrigin, isMainFrame, reply) -> {
            if (!isMainFrame || !ORIGIN.equals(sourceOrigin.toString())) return;
            try {
                JSONObject input = new JSONObject(message.getData());
                if (input.optString("type").equals("playerLayout")) {
                    if (input.opt("expanded") instanceof Boolean && input.opt("lockLandscape") instanceof Boolean) {
                        setPlayerLayout(input.getBoolean("expanded"), input.getBoolean("lockLandscape"));
                    }
                    return;
                }
                String id = input.optString("id");
                if (!id.matches("[0-9]{1,12}")) return;
                if (input.optString("type").equals("cancel")) {
                    if (activeId.equals(id)) cancelExtraction();
                    return;
                }
                if (!input.optString("type").equals("extract")) return;
                String videoId = input.optString("videoId");
                String lang = input.optString("lang", "en");
                if (!videoId.matches("[A-Za-z0-9_-]{11}") || !lang.matches("[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?")) {
                    reply.postMessage(new JSONObject().put("id", id).put("ok", false).put("reason", "invalid_request")
                        .put("error", "Érvénytelen feliratkérés.").toString());
                    return;
                }
                cancelExtraction();
                activeId = id;
                int epoch = pageEpoch;
                extraction = executor.submit(() -> {
                    JSONObject result;
                    try { result = new JSONObject().put("id", id).put("ok", true).put("data", extractor.extract(videoId, lang, (stage, percent) -> runOnUiThread(() -> {
                        if (!isDestroyed() && epoch == pageEpoch && activeId.equals(id)) try {
                            reply.postMessage(new JSONObject().put("id", id).put("type", "progress").put("stage", stage).put("percent", percent).toString());
                        } catch (Exception ignored) {}
                    }))); }
                    catch (Exception error) { result = failure(id, error); }
                    final String json = result.toString();
                    runOnUiThread(() -> {
                        if (!isDestroyed() && epoch == pageEpoch && activeId.equals(id)) {
                            activeId = "";
                            reply.postMessage(json);
                        }
                    });
                });
            } catch (Exception ignored) { /* Malformed or closed-port messages have no native capability. */ }
        });
        loadIntent(getIntent());
    }

    private static JSONObject failure(String id, Exception error) {
        String reason = "extractor_error";
        String text = "A telefonos feliratkinyerő nem tudta feldolgozni a videót. Próbáld újra, vagy válassz másik videót.";
        if (error instanceof CaptionExtractor.CaptionFailure known) { reason = known.reason; text = known.getMessage(); }
        else {
            for (Throwable cause = error; cause != null; cause = cause.getCause()) {
                String type = cause.getClass().getSimpleName();
                String message = String.valueOf(cause.getMessage()).toLowerCase(java.util.Locale.ROOT);
                if (isUnexpectedUpstreamHtml(type, message)) {
                    reason = "upstream_invalid_response";
                    text = "A YouTube feliratadatok helyett weboldalt adott vissza. A letöltő ezt nem tudja feldolgozni; próbáld újra később."; break;
                }
                if (type.contains("ReCaptcha") || message.contains("not a bot") || message.contains("sign in to confirm")) {
                    reason = "youtube_blocked"; text = "A YouTube a telefonról érkező kéréshez is ellenőrzést kér. A feliratot ezért nem lehetett letölteni."; break;
                }
                if (type.contains("AgeRestricted")) { reason = "age_restricted"; text = "A videó korhatáros, a felirat bejelentkezés nélkül nem érhető el."; break; }
                if (type.contains("ContentNotAvailable")) { reason = "unavailable"; text = "A videó nem érhető el, vagy hozzáférési korlátozása van."; break; }
                if (cause instanceof IOException) { reason = "network_error"; text = "Hálózati hiba történt a felirat lekérésekor. Ellenőrizd az internetkapcsolatot, majd próbáld újra."; }
            }
        }
        JSONObject result = new JSONObject();
        String diagnostic = (error.getClass().getSimpleName() + ": " + String.valueOf(error.getMessage()))
            .replaceAll("https?://\\S+", "[URL]");
        if (diagnostic.length() > 220) diagnostic = diagnostic.substring(0, 220);
        Log.w("HUCaptionExtractor", "reason=" + reason + "; " + diagnostic);
        try { result.put("id", id).put("ok", false).put("reason", reason).put("error", text)
            .put("diagnostic", diagnostic)
            .put("extractorVersion", "0.27.1").put("nativeVersion", BuildConfig.VERSION_NAME); }
        catch (Exception ignored) {}
        return result;
    }

    static boolean isUnexpectedUpstreamHtml(String type, String message) {
        String normalized = message.toLowerCase(java.util.Locale.ROOT);
        return type.contains("Parsing") && normalized.contains("got html document") && normalized.contains("expected json response");
    }

    private void cancelExtraction() {
        LocalSpeech.cancel();
        activeId = "";
        if (extraction != null) extraction.cancel(true);
        executor.getQueue().clear();
    }
    private void loadIntent(Intent intent) {
        String shared = Intent.ACTION_SEND.equals(intent.getAction()) ? intent.getStringExtra(Intent.EXTRA_TEXT) : null;
        webView.loadUrl(ORIGIN + "/" + (shared == null ? "" : "?url=" + Uri.encode(shared)));
    }
    @Override protected void onNewIntent(Intent intent) { super.onNewIntent(intent); setIntent(intent); if (webView != null) loadIntent(intent); }
    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request == 101 && fileCallback != null) {
            fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result, data)); fileCallback = null;
        }
    }
    private void setPlayerLayout(boolean expanded, boolean lockLandscape) {
        if (playerExpanded != expanded) {
            playerExpanded = expanded;
            root.setBackgroundColor(expanded ? Color.BLACK : Color.rgb(10, 18, 24));
            applyPlayerWindow();
            ViewCompat.requestApplyInsets(root);
        }
        boolean lock = expanded && lockLandscape;
        if (playerOrientationLocked != lock) {
            playerOrientationLocked = lock;
            setRequestedOrientation(lock ? ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE : ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
        }
    }
    private void applyPlayerWindow() {
        WindowInsetsControllerCompat bars = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        bars.setAppearanceLightStatusBars(false);
        bars.setAppearanceLightNavigationBars(false);
        bars.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        if (playerExpanded) bars.hide(WindowInsetsCompat.Type.systemBars());
        else bars.show(WindowInsetsCompat.Type.systemBars());
    }
    @Override public void onBackPressed() {
        if (playerExpanded) webView.evaluateJavascript("window.dispatchEvent(new Event('hu-exit-player'))", null);
        else if (webView != null && webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }
    @Override protected void onPause() { if (webView != null) webView.onPause(); super.onPause(); }
    @Override protected void onResume() { super.onResume(); if (webView != null) { webView.onResume(); applyPlayerWindow(); } }
    @Override protected void onDestroy() {
        cancelExtraction(); executor.shutdownNow();
        if (fileCallback != null) fileCallback.onReceiveValue(null);
        if (webView != null) { WebViewCompat.removeWebMessageListener(webView, "HUCaptionNative"); webView.destroy(); }
        super.onDestroy();
    }
}
