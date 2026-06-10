package com.animetv.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Message;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

public class MainActivity extends Activity {
    // ── Backend configuration ────────────────────────────────────────────────
    // Points at the deployed ZenkaiTV website so the TV app has FULL functionality
    // (TioAnime / AnimeAV1 / AniPub playback need the hosted /api backend, which is
    // unavailable from a bundled file:// build). The custom domain is public and is
    // not behind Vercel Deployment Protection.
    // Set to "" to fall back to the bundled offline catalog (browse only, no proxied
    // playback).
    private static final String SITE_URL = "https://zenkaitv.com";

    // Single live instance so the (separate) PlayerActivity can report playback
    // progress back into this WebView's JS for local watch-tracking.
    private static MainActivity sInstance;

    private WebView webView;
    private View customView;
    private WebChromeClient.CustomViewCallback customViewCallback;

    /** Called from PlayerActivity to push a progress update into the web app. */
    public static void reportProgress(final String episodeKey, final long positionMs,
                                      final long durationMs, final boolean completed) {
        final MainActivity self = sInstance;
        if (self == null || self.webView == null || episodeKey == null) return;
        final String safeKey = episodeKey.replace("\\", "\\\\").replace("'", "\\'");
        final String js = "window.ZenkaiTrackProgress && window.ZenkaiTrackProgress('"
            + safeKey + "'," + positionMs + "," + durationMs + "," + (completed ? "true" : "false") + ")";
        self.runOnUiThread(new Runnable() {
            @Override public void run() {
                try { self.webView.evaluateJavascript(js, null); } catch (Exception ignored) {}
            }
        });
    }

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        sInstance = this;
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN, WindowManager.LayoutParams.FLAG_FULLSCREEN);

        webView = new WebView(this);
        webView.setFocusable(true);
        webView.setFocusableInTouchMode(true);
        webView.setWebViewClient(new WebViewClient());
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                if (customView != null) {
                    callback.onCustomViewHidden();
                    return;
                }
                customView = view;
                customViewCallback = callback;
                setContentView(customView, new ViewGroup.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT
                ));
                applyImmersiveMode(customView);
            }

            @Override
            public void onHideCustomView() {
                hideCustomView();
            }

            @Override
            public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, Message resultMsg) {
                WebView popup = new WebView(MainActivity.this);
                popup.setWebViewClient(new WebViewClient() {
                    @Override
                    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                        openExternalUrl(request.getUrl().toString());
                        return true;
                    }

                    @SuppressWarnings("deprecation")
                    @Override
                    public boolean shouldOverrideUrlLoading(WebView view, String url) {
                        openExternalUrl(url);
                        return true;
                    }
                });

                WebView.WebViewTransport transport = (WebView.WebViewTransport) resultMsg.obj;
                transport.setWebView(popup);
                resultMsg.sendToTarget();
                return true;
            }
        });

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(true);
        settings.setSupportMultipleWindows(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setLoadsImagesAutomatically(true);

        // Native-player bridge: the web app calls ZenkaiNative.play(url, title, type,
        // headers) to hand a resolved stream off to ExoPlayer (HLS/MP4 the WebView can't).
        webView.addJavascriptInterface(new ZenkaiBridge(), "ZenkaiNative");

        applyImmersiveMode(webView);

        setContentView(webView);
        // Load the hosted site when configured (full playback), else the bundled build.
        webView.loadUrl(SITE_URL.isEmpty() ? "file:///android_asset/index.html" : SITE_URL);
    }

    private void applyImmersiveMode(View view) {
        if (view == null) return;
        view.setSystemUiVisibility(
            View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
        );
    }

    private void hideCustomView() {
        if (customView == null) return;
        customView = null;
        setContentView(webView);
        if (customViewCallback != null) {
            customViewCallback.onCustomViewHidden();
            customViewCallback = null;
        }
        applyImmersiveMode(webView);
    }

    private void openExternalUrl(String url) {
        if (url == null || url.isEmpty()) return;
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
        startActivity(intent);
    }

    private void launchPlayer(String url, String title, String type, String headers,
                              String referer, long startMs, String episodeKey) {
        if (url == null || url.isEmpty()) return;
        final Intent intent = new Intent(MainActivity.this, PlayerActivity.class);
        intent.putExtra("url", url);
        intent.putExtra("title", title);
        intent.putExtra("type", type);
        intent.putExtra("headers", headers);
        intent.putExtra("referer", referer);
        intent.putExtra("startMs", startMs);
        intent.putExtra("episodeKey", episodeKey == null ? "" : episodeKey);
        runOnUiThread(new Runnable() {
            @Override public void run() { startActivity(intent); }
        });
    }

    /** JS-accessible bridge so the web UI can launch the native ExoPlayer. */
    private class ZenkaiBridge {
        @JavascriptInterface
        public void play(final String url, final String title, final String type, final String headers, final String referer) {
            launchPlayer(url, title, type, headers, referer, 0L, "");
        }

        /** Resume-aware variant: seeks to startMs and reports progress back to JS. */
        @JavascriptInterface
        public void playTracked(final String url, final String title, final String type, final String headers,
                                final String referer, final long startMs, final String episodeKey) {
            launchPlayer(url, title, type, headers, referer, startMs, episodeKey);
        }

        /** Lets the web app feature-detect native playback support. */
        @JavascriptInterface
        public boolean available() { return true; }

        /** Feature-detect resume/progress tracking support. */
        @JavascriptInterface
        public boolean supportsTracking() { return true; }
    }

    @Override
    protected void onResume() {
        super.onResume();
        // Returning from the player → refresh the Continue Watching rail.
        if (webView != null) {
            try {
                webView.evaluateJavascript("window.ZenkaiRefreshHome && window.ZenkaiRefreshHome()", null);
            } catch (Exception ignored) {}
        }
    }

    @Override
    protected void onDestroy() {
        if (sInstance == this) sInstance = null;
        super.onDestroy();
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        return super.dispatchKeyEvent(event);
    }

    @Override
    public void onBackPressed() {
        if (customView != null) {
            hideCustomView();
        } else if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }
}
