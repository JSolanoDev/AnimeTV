package com.animetv.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;
import android.widget.Toast;

import androidx.media3.common.MediaItem;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.ui.PlayerView;

import org.json.JSONObject;

import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Native ExoPlayer screen. Direct streams (.m3u8/.mp4) play immediately. Embed
 * pages (Streamwish/Filemoon/Voe/…) are opened in a hidden WebView whose own JS
 * deobfuscates and requests the real stream — we intercept that request and hand
 * the URL to ExoPlayer. This makes "every source plays in the native player" work
 * even for obfuscated hosts that can't be unpacked server-side.
 */
@UnstableApi
public class PlayerActivity extends Activity {
    private static final String UA =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";

    private ExoPlayer player;
    private PlayerView playerView;
    private WebView sniffer;
    private FrameLayout root;
    private TextView status;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private final AtomicBoolean handled = new AtomicBoolean(false);
    private String referer = "";

    // Watch-tracking: resume point + which episode this playback belongs to.
    private long startMs = 0;
    private String episodeKey = "";
    private final Handler progressHandler = new Handler(Looper.getMainLooper());
    private Runnable progressTick;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN, WindowManager.LayoutParams.FLAG_FULLSCREEN);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        root = new FrameLayout(this);
        playerView = new PlayerView(this);
        playerView.setUseController(true);
        playerView.setKeepContentOnPlayerReset(true);
        root.addView(playerView, new FrameLayout.LayoutParams(-1, -1));
        status = new TextView(this);
        status.setTextColor(0xFFFFFFFF);
        status.setTextSize(16);
        status.setPadding(48, 48, 48, 48);
        status.setText("Loading…");
        root.addView(status, new FrameLayout.LayoutParams(-2, -2));
        setContentView(root);
        applyImmersive(root);

        String url = getIntent().getStringExtra("url");
        String type = getIntent().getStringExtra("type");
        referer = getIntent().getStringExtra("referer");
        if (referer == null) referer = "";
        startMs = getIntent().getLongExtra("startMs", 0L);
        episodeKey = getIntent().getStringExtra("episodeKey");
        if (episodeKey == null) episodeKey = "";
        Map<String, String> headers = parseHeaders(getIntent().getStringExtra("headers"));

        if (url == null || url.isEmpty()) {
            Toast.makeText(this, "No video URL provided.", Toast.LENGTH_LONG).show();
            finish();
            return;
        }

        boolean direct = "hls".equalsIgnoreCase(type) || "mp4".equalsIgnoreCase(type) || isStreamUrl(url);
        if (direct) {
            playStream(url, type, headers);
        } else {
            sniffEmbed(url);
        }
    }

    // ── Direct playback ──────────────────────────────────────────────────────
    private void playStream(String url, String type, Map<String, String> headers) {
        status.setVisibility(View.GONE);
        DefaultHttpDataSource.Factory http = new DefaultHttpDataSource.Factory()
            .setUserAgent(UA)
            .setAllowCrossProtocolRedirects(true)
            .setConnectTimeoutMs(15000)
            .setReadTimeoutMs(20000);
        Map<String, String> h = new HashMap<>(headers);
        if (!referer.isEmpty() && !h.containsKey("Referer")) h.put("Referer", referer);
        if (!h.isEmpty()) http.setDefaultRequestProperties(h);

        MediaItem.Builder item = new MediaItem.Builder().setUri(Uri.parse(url));
        if ("hls".equalsIgnoreCase(type) || url.contains(".m3u8")) item.setMimeType(MimeTypes.APPLICATION_M3U8);
        else if ("mp4".equalsIgnoreCase(type)) item.setMimeType(MimeTypes.VIDEO_MP4);

        if (player != null) player.release();
        player = new ExoPlayer.Builder(this)
            .setMediaSourceFactory(new DefaultMediaSourceFactory(http))
            .build();
        playerView.setPlayer(player);
        player.addListener(new Player.Listener() {
            @Override
            public void onPlayerError(PlaybackException error) {
                Toast.makeText(PlayerActivity.this, "Playback error: " + error.getErrorCodeName(), Toast.LENGTH_LONG).show();
            }
            @Override
            public void onPlaybackStateChanged(int state) {
                if (state == Player.STATE_ENDED) reportProgress(true);
            }
        });
        player.setMediaItem(item.build());
        player.setPlayWhenReady(true);
        player.prepare();
        if (startMs > 0) player.seekTo(startMs);
        startProgressReporting();
    }

    // ── Watch-tracking: push position back into the web app's localStorage ────
    private void startProgressReporting() {
        if (episodeKey == null || episodeKey.isEmpty()) return;
        stopProgressReporting();
        progressTick = new Runnable() {
            @Override public void run() {
                reportProgress(false);
                progressHandler.postDelayed(this, 10000); // every 10s
            }
        };
        progressHandler.postDelayed(progressTick, 10000);
    }

    private void stopProgressReporting() {
        if (progressTick != null) progressHandler.removeCallbacks(progressTick);
        progressTick = null;
    }

    private void reportProgress(boolean completed) {
        if (player == null || episodeKey == null || episodeKey.isEmpty()) return;
        long pos = Math.max(0, player.getCurrentPosition());
        long dur = player.getDuration();
        if (dur <= 0) return; // duration not known yet — nothing useful to save
        boolean done = completed || pos >= dur * 0.95;
        MainActivity.reportProgress(episodeKey, pos, dur, done);
    }

    // ── Embed sniffer ────────────────────────────────────────────────────────
    @SuppressLint("SetJavaScriptEnabled")
    private void sniffEmbed(final String embedUrl) {
        status.setText("Resolving source…");
        if (referer.isEmpty()) referer = origin(embedUrl);
        sniffer = new WebView(this);
        WebSettings s = sniffer.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setJavaScriptCanOpenWindowsAutomatically(true);
        s.setUserAgentString(UA);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        // Full-size but behind the status text, so the embed's <video>/player layout
        // and renders (many players won't request the stream until they're visible).
        root.addView(sniffer, 0, new FrameLayout.LayoutParams(-1, -1));

        sniffer.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                String u = request.getUrl() != null ? request.getUrl().toString() : "";
                if (isStreamUrl(u)) onStreamSniffed(u);
                return null;   // observe only, don't block
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                // Many embeds only fetch the stream after a play-click; trigger one a
                // few times to cover late-loading players.
                for (int delay : new int[]{300, 1500, 3500, 6000}) {
                    ui.postDelayed(() -> kickPlay(), delay);
                }
            }
        });

        Map<String, String> reqHeaders = new HashMap<>();
        if (!referer.isEmpty()) reqHeaders.put("Referer", referer);
        sniffer.loadUrl(embedUrl, reqHeaders);

        // Give up if no stream shows up.
        ui.postDelayed(() -> {
            if (!handled.get()) {
                handled.set(true);
                Toast.makeText(PlayerActivity.this, "Couldn't find a playable stream for this source.", Toast.LENGTH_LONG).show();
                finish();
            }
        }, 22000);
    }

    private void onStreamSniffed(final String streamUrl) {
        if (!handled.compareAndSet(false, true)) return;
        ui.post(() -> {
            destroySniffer();
            Map<String, String> h = new HashMap<>();
            if (!referer.isEmpty()) h.put("Referer", referer);
            playStream(streamUrl, streamUrl.contains(".m3u8") ? "hls" : "mp4", h);
        });
    }

    // Nudge the embed's player to start (autoplay/click) so it fetches the stream.
    private void kickPlay() {
        if (sniffer == null || handled.get()) return;
        String js = "(function(){try{"
            + "var v=document.querySelector('video');"
            + "if(v){v.muted=true;try{var p=v.play();if(p&&p.catch)p.catch(function(){});}catch(e){}}"
            + "var sel=['.jw-icon-display','.vjs-big-play-button','.plyr__control--overlaid','.play-button','#play','.play','button[aria-label*=play i]','button'];"
            + "for(var i=0;i<sel.length;i++){var b=document.querySelector(sel[i]);if(b){try{b.click();}catch(e){}break;}}"
            + "var c=document.elementFromPoint(window.innerWidth/2,window.innerHeight/2);"
            + "if(c&&c.click){try{c.click();}catch(e){}}"
            + "}catch(e){}})()";
        try { sniffer.evaluateJavascript(js, null); } catch (Exception ignored) {}
    }

    private void destroySniffer() {
        if (sniffer != null) {
            try { sniffer.stopLoading(); sniffer.loadUrl("about:blank"); root.removeView(sniffer); sniffer.destroy(); } catch (Exception ignored) {}
            sniffer = null;
        }
    }

    // A real video stream worth sniffing (skip the player's own UI/css/js/img).
    private static boolean isStreamUrl(String u) {
        if (u == null) return false;
        String low = u.toLowerCase();
        return low.contains(".m3u8") || low.contains(".mp4") || low.contains("/manifest") || low.contains(".mpd");
    }

    private static String origin(String url) {
        try { Uri u = Uri.parse(url); return u.getScheme() + "://" + u.getHost() + "/"; } catch (Exception e) { return ""; }
    }

    private Map<String, String> parseHeaders(String json) {
        Map<String, String> map = new HashMap<>();
        if (json == null || json.isEmpty()) return map;
        try {
            JSONObject o = new JSONObject(json);
            Iterator<String> keys = o.keys();
            while (keys.hasNext()) { String k = keys.next(); map.put(k, o.getString(k)); }
        } catch (Exception ignored) {}
        return map;
    }

    private void applyImmersive(View view) {
        view.setSystemUiVisibility(
            View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
        );
    }

    @Override
    protected void onPause() {
        super.onPause();
        reportProgress(false);
        if (player != null) player.pause();
    }

    @Override
    protected void onDestroy() {
        reportProgress(false);
        stopProgressReporting();
        super.onDestroy();
        destroySniffer();
        if (player != null) { player.release(); player = null; }
    }
}
