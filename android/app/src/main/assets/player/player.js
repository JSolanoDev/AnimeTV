(function () {
  "use strict";

  const params = new URLSearchParams(window.location.search);
  const sourceUrl = firstParam("src", "url", "videoUrl", "file");
  const title = firstParam("title", "name") || "ZenkaiTV Video";
  const episode = firstParam("episode", "ep") || "";
  const poster = firstParam("poster", "thumb") || "";
  const subtitle = firstParam("subtitle", "sub") || "";
  const tracks = parseTracks(params.get("tracks"));
  const startAt = Number(params.get("start") || 0);
  const fit = String(params.get("fit") || params.get("scale") || "contain").toLowerCase();
  const forceSubtitles = params.get("forceSubtitles") === "1";
  let art = null;
  let hls = null;
  let statusTimer = null;
  let startupTimer = null;
  let recoveryTimer = null;
  let recoveryCount = 0;
  let lastSeekToast = 0;

  const elements = {
    player: document.getElementById("player"),
    back: document.getElementById("backButton"),
    home: document.getElementById("homeButton"),
    retry: document.getElementById("retryButton"),
    loading: document.getElementById("loadingState"),
    error: document.getElementById("errorState"),
    errorTitle: document.getElementById("errorTitle"),
    errorMessage: document.getElementById("errorMessage"),
    title: document.getElementById("playerTitle"),
    episode: document.getElementById("episodeLabel"),
    backdrop: document.getElementById("playerBackdrop")
  };

  document.title = `${title}${episode ? ` - ${episode}` : ""} - ZenkaiTV`;
  elements.title.textContent = title;
  elements.episode.textContent = episode || "ZenkaiTV";
  if (poster) {
    elements.backdrop.style.backgroundImage = `url("${cssUrl(poster)}")`;
  }
  if (fit === "cover" || fit === "1") document.body.classList.add("fit-cover");
  if (fit === "fill" || fit === "2") document.body.classList.add("fit-fill");

  elements.back.addEventListener("click", goBack);
  elements.home.addEventListener("click", () => { window.location.href = "/"; });
  elements.retry.addEventListener("click", () => {
    hideError();
    initPlayer();
  });

  window.addEventListener("message", onParentCommand);
  window.addEventListener("keydown", onKeydown, true);
  window.addEventListener("beforeunload", () => {
    window.removeEventListener("keydown", onKeydown, true);
    destroyPlayer();
  });

  if (!sourceUrl) {
    showError("No video source", "This player did not receive a playable video URL.");
    send("error", "missing-source");
    return;
  }

  waitForLibraries().then(initPlayer).catch((error) => {
    console.error("[ZenkaiPlayer] Libraries failed to load", error);
    showError("Player failed to load", "ArtPlayer or hls.js could not be loaded. Check your connection and retry.");
    send("error", "library-load-failed");
  });

  function firstParam(...keys) {
    for (const key of keys) {
      const value = params.get(key);
      if (value) return value;
    }
    return "";
  }

  function waitForLibraries() {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const wantsHls = streamType(sourceUrl, params.get("type")) === "m3u8";
      const tick = () => {
        if (window.Artplayer && (!wantsHls || window.Hls)) {
          resolve();
          return;
        }
        if (Date.now() - started > 10000) {
          reject(new Error(wantsHls ? "ArtPlayer or hls.js timeout" : "ArtPlayer timeout"));
          return;
        }
        setTimeout(tick, 40);
      };
      tick();
    });
  }

  function initPlayer() {
    destroyPlayer();
    hideError();
    showLoading();
    recoveryCount = 0;
    armStartupWatchdog();

    const type = streamType(sourceUrl, params.get("type"));
    const subtitleConfig = buildSubtitleConfig();
    const playerOptions = {
      container: elements.player,
      url: sourceUrl,
      type,
      title,
      poster,
      theme: "#8b5cf6",
      volume: 0.8,
      autoplay: true,
      preload: "auto",
      muted: false,
      pip: true,
      autoSize: false,
      autoMini: false,
      screenshot: false,
      setting: true,
      loop: false,
      flip: true,
      playbackRate: true,
      aspectRatio: true,
      fullscreen: true,
      fullscreenWeb: true,
      hotkey: true,
      mutex: true,
      playsInline: true,
      airplay: true,
      lock: true,
      fastForward: true,
      autoOrientation: true,
      customType: {
        m3u8(video, url) {
          loadHls(video, url);
        }
      }
    };
    if (subtitleConfig) playerOptions.subtitle = subtitleConfig;

    art = new window.Artplayer(playerOptions);
    wireArtEvents();
  }

  function wireArtEvents() {
    if (!art) return;
    const video = art.video;
    if (video) {
      video.preload = "auto";
    }

    art.on("ready", () => {
      send("ready", getStatus());
      send("loadedmetadata", getStatus());
      armStartupWatchdog();
      if (startAt > 0) {
        try { video.currentTime = startAt; } catch (error) {}
      }
      if (forceSubtitles && art.subtitle) {
        try { art.subtitle.show = true; } catch (error) {}
      }
    });

    art.on("video:loadedmetadata", () => {
      send("loadedmetadata", getStatus());
      reportResolution();
    });
    art.on("video:loadeddata", () => {
      hideLoading();
      send("loadeddata", getStatus());
      reportResolution();
    });
    art.on("video:canplay", () => {
      clearStartupWatchdog();
      hideLoading();
      send("canplay", getStatus());
      reportResolution();
    });
    art.on("video:canplaythrough", () => {
      clearStartupWatchdog();
      hideLoading();
      send("canplaythrough", getStatus());
    });
    art.on("video:playing", () => {
      clearStartupWatchdog();
      hideLoading();
      send("playing", getStatus());
      send("play", getStatus());
      startStatusLoop();
    });
    art.on("video:pause", () => {
      send("pause", getStatus());
      stopStatusLoop();
    });
    art.on("video:waiting", () => {
      if (bufferedEnd(video) - (video.currentTime || 0) < 0.35) showLoading();
      send("waiting", getStatus());
      scheduleRecovery("waiting");
    });
    art.on("video:stalled", () => {
      send("stalled", getStatus());
      scheduleRecovery("stalled");
    });
    art.on("video:ended", () => {
      send("complete", getStatus());
      stopStatusLoop();
    });
    art.on("video:timeupdate", () => {
      send("time", getStatus());
    });
    art.on("video:volumechange", () => {
      send("volume", getStatus());
    });
    art.on("error", (error) => {
      console.error("[ZenkaiPlayer] ArtPlayer error", error);
      clearStartupWatchdog();
      showError("Video failed to load", "This stream could not be played. Try another source or retry this episode.");
      send("error", "playback-error");
    });

    const playAttempt = video?.play?.();
    if (playAttempt && typeof playAttempt.catch === "function") {
      playAttempt.catch(() => {
        hideLoading();
        send("pause", getStatus());
      });
    }
  }

  function loadHls(video, url) {
    destroyHls();
    if (!window.Hls || !window.Hls.isSupported()) {
      if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = url;
        return;
      }
      showError("HLS is not supported", "This browser cannot play HLS streams and hls.js is not available.");
      send("error", "hls-not-supported");
      return;
    }
    hls = new window.Hls({
      enableWorker: true,
      lowLatencyMode: true,
      startFragPrefetch: true,
      backBufferLength: 30,
      maxBufferLength: 45,
      maxMaxBufferLength: 90,
      maxBufferHole: 0.5,
      capLevelToPlayerSize: false,
      manifestLoadingTimeOut: 10000,
      manifestLoadingMaxRetry: 3,
      manifestLoadingRetryDelay: 600,
      levelLoadingTimeOut: 10000,
      levelLoadingMaxRetry: 4,
      levelLoadingRetryDelay: 600,
      fragLoadingTimeOut: 15000,
      fragLoadingMaxRetry: 4,
      fragLoadingRetryDelay: 600
    });
    hls.attachMedia(video);
    hls.on(window.Hls.Events.MEDIA_ATTACHED, () => {
      hls.loadSource(url);
    });
    hls.on(window.Hls.Events.MANIFEST_PARSED, (_, data) => {
      const levels = (data?.levels || []).map((level, index) => ({
        index,
        height: level.height,
        width: level.width,
        bitrate: level.bitrate
      }));
      send("qualities", levels);
      reportResolution();
      armStartupWatchdog();
      const playAttempt = video.play();
      if (playAttempt && typeof playAttempt.catch === "function") playAttempt.catch(() => hideLoading());
    });
    hls.on(window.Hls.Events.ERROR, (_, data) => {
      if (!data?.fatal) return;
      console.error("[ZenkaiPlayer] HLS fatal error", JSON.stringify({
        type: data.type,
        details: data.details,
        reason: data.reason,
        error: data.error?.message || String(data.error || ""),
        response: data.response ? {
          code: data.response.code,
          text: data.response.text,
          url: data.response.url
        } : null
      }));
      if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) {
        recoveryCount += 1;
        if (recoveryCount <= 4) {
          hls.startLoad(video.currentTime || -1);
          return;
        }
        clearStartupWatchdog();
        showError("Network is too slow", "The stream kept timing out. Retry this source or choose another server.");
        return;
      }
      if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) {
        recoveryCount += 1;
        if (recoveryCount > 3) {
          clearStartupWatchdog();
          showError("Stream could not recover", "The video stream is not responding correctly. Try another source.");
          send("error", "hls-media-fatal");
          return;
        }
        hls.recoverMediaError();
        return;
      }
      clearStartupWatchdog();
      showError("HLS stream failed", "The HLS stream could not be loaded. Try another source.");
      send("error", "hls-fatal");
    });
  }

  function streamType(url, hint) {
    const normalizedHint = String(hint || "").toLowerCase();
    if (normalizedHint === "m3u8" || normalizedHint === "hls") return "m3u8";
    const clean = String(url || "").split("?")[0].split("#")[0].toLowerCase();
    if (clean.endsWith(".m3u8")) return "m3u8";
    if (clean.endsWith(".webm")) return "webm";
    if (clean.endsWith(".mp4") || clean.endsWith(".m4v")) return "mp4";
    return "";
  }

  function buildSubtitleConfig() {
    const selected = subtitle || findPreferredTrack()?.url || "";
    if (!selected) return null;
    const type = selected.split("?")[0].toLowerCase().endsWith(".ass") ? "ass" : "vtt";
    return {
      url: selected,
      type,
      encoding: "utf-8",
      escape: false,
      style: {
        color: "#fff",
        fontSize: "22px",
        fontWeight: "800",
        textShadow: "0 2px 8px rgba(0,0,0,.9)"
      }
    };
  }

  function findPreferredTrack() {
    if (!tracks.length) return null;
    const preference = String(params.get("subtitles") || "").toLowerCase();
    const spanish = tracks.find((track) => /spanish|español|es\b|spa/i.test(`${track.label || ""} ${track.language || ""}`));
    if (forceSubtitles && spanish) return spanish;
    if (preference) {
      const found = tracks.find((track) => `${track.label || ""} ${track.language || ""}`.toLowerCase().includes(preference));
      if (found) return found;
    }
    return spanish || tracks[0] || null;
  }

  function parseTracks(value) {
    if (!value) return [];
    try {
      const decoded = decodeURIComponent(value);
      const parsed = JSON.parse(decoded);
      return Array.isArray(parsed) ? parsed.filter((track) => track && track.url) : [];
    } catch (error) {
      try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed.filter((track) => track && track.url) : [];
      } catch (innerError) {
        return [];
      }
    }
  }

  function getStatus() {
    const video = art?.video;
    if (!video) return {};
    return {
      position: video.currentTime || 0,
      duration: video.duration || 0,
      buffer: bufferedEnd(video),
      paused: video.paused,
      muted: video.muted,
      volume: video.volume,
      rate: video.playbackRate
    };
  }

  function bufferedEnd(video) {
    try {
      if (!video?.buffered?.length) return 0;
      return video.buffered.end(video.buffered.length - 1) || 0;
    } catch (error) {
      return 0;
    }
  }

  function bufferedAhead(video) {
    return Math.max(0, bufferedEnd(video) - (video?.currentTime || 0));
  }

  function startStatusLoop() {
    stopStatusLoop();
    statusTimer = setInterval(() => send("time", getStatus()), 1000);
  }

  function stopStatusLoop() {
    if (statusTimer) clearInterval(statusTimer);
    statusTimer = null;
  }

  function reportResolution() {
    const video = art?.video;
    if (!video?.videoWidth || !video?.videoHeight) return;
    send("resolution", `${video.videoWidth}x${video.videoHeight}`);
  }

  function onParentCommand(event) {
    let data = event.data;
    try {
      if (typeof data === "string") data = JSON.parse(data);
    } catch (error) {
      return;
    }
    if (!data?.vcmd || !art?.video) return;
    const video = art.video;
    const command = data.vcmd;
    const value = data.val;
    if (command === "play") video.play?.();
    if (command === "pause") video.pause?.();
    if (command === "seek") video.currentTime = Math.max(0, Number(value) || 0);
    if (command === "speed") video.playbackRate = Number(value) || 1;
    if (command === "volume") video.volume = Math.max(0, Math.min(1, Number(value) || 0));
    if (command === "muted") video.muted = Boolean(value);
    if (command === "scale") {
      document.body.classList.toggle("fit-cover", Number(value) === 1);
      document.body.classList.toggle("fit-fill", Number(value) === 2);
    }
    if (command === "toggleFullscreen") {
      art.fullscreen = !art.fullscreen;
    }
  }

  function onKeydown(event) {
    if (event.defaultPrevented || !art?.video || isEditableTarget(event.target)) return;
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    event.stopPropagation();
    seekBy(event.key === "ArrowRight" ? 10 : -10);
  }

  function isEditableTarget(target) {
    if (!target) return false;
    const tag = String(target.tagName || "").toLowerCase();
    return tag === "input" || tag === "textarea" || tag === "select" || target.isContentEditable;
  }

  function seekBy(delta) {
    const video = art?.video;
    if (!video) return;
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : Infinity;
    const nextTime = Math.max(0, Math.min(duration, (video.currentTime || 0) + delta));
    try {
      video.currentTime = nextTime;
      if (video.paused) {
        const playAttempt = video.play?.();
        if (playAttempt && typeof playAttempt.catch === "function") playAttempt.catch(() => {});
      }
      hideLoading();
      showSeekToast(delta);
      send("seek", getStatus());
    } catch (error) {
      console.warn("[ZenkaiPlayer] Seek failed", error);
    }
  }

  function showSeekToast(delta) {
    const now = Date.now();
    if (now - lastSeekToast < 80) return;
    lastSeekToast = now;
    let toast = document.getElementById("seekToast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "seekToast";
      toast.className = "ztv-seek-toast";
      document.body.appendChild(toast);
    }
    toast.textContent = `${delta > 0 ? "+" : ""}${delta}s`;
    toast.hidden = false;
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => { toast.hidden = true; }, 650);
  }

  function armStartupWatchdog() {
    clearStartupWatchdog();
    startupTimer = setTimeout(() => {
      const video = art?.video;
      if (!video || elements.error.hidden === false) return;
      if (video.readyState >= 3 || bufferedAhead(video) > 1 || !video.paused) {
        hideLoading();
        return;
      }
      scheduleRecovery("startup");
      if (recoveryCount >= 3) {
        showError("Stream is taking too long", "The server is buffering too slowly. Retry this episode or choose another source.");
        send("error", "startup-timeout");
      }
    }, 18000);
  }

  function clearStartupWatchdog() {
    if (startupTimer) clearTimeout(startupTimer);
    startupTimer = null;
  }

  function scheduleRecovery(reason) {
    const video = art?.video;
    if (!video || recoveryTimer || bufferedAhead(video) > 2) return;
    recoveryTimer = setTimeout(() => {
      recoveryTimer = null;
      const currentVideo = art?.video;
      if (!currentVideo || bufferedAhead(currentVideo) > 2 || elements.error.hidden === false) return;
      recoveryCount += 1;
      send("recover", { reason, count: recoveryCount, ...getStatus() });
      if (hls) {
        try { hls.startLoad(currentVideo.currentTime || -1); } catch (error) {}
      } else if (currentVideo.readyState < 2 && recoveryCount <= 2) {
        try { currentVideo.load(); } catch (error) {}
      }
      const playAttempt = currentVideo.play?.();
      if (playAttempt && typeof playAttempt.catch === "function") playAttempt.catch(() => {});
    }, 1200);
  }

  function send(command, value) {
    try {
      window.parent?.postMessage(JSON.stringify({ vcmd: command, val: value }), "*");
    } catch (error) {}
  }

  function showLoading() {
    elements.loading.hidden = false;
  }

  function hideLoading() {
    elements.loading.hidden = true;
  }

  function showError(errorTitle, message) {
    hideLoading();
    elements.errorTitle.textContent = errorTitle;
    elements.errorMessage.textContent = message;
    elements.error.hidden = false;
  }

  function hideError() {
    elements.error.hidden = true;
  }

  function goBack() {
    if (window.history.length > 1) {
      window.history.back();
    } else {
      window.location.href = "/";
    }
  }

  function destroyHls() {
    if (!hls) return;
    try { hls.destroy(); } catch (error) {}
    hls = null;
  }

  function destroyPlayer() {
    stopStatusLoop();
    clearStartupWatchdog();
    if (recoveryTimer) clearTimeout(recoveryTimer);
    recoveryTimer = null;
    destroyHls();
    if (!art) return;
    try { art.destroy(false); } catch (error) {}
    art = null;
  }

  function cssUrl(value) {
    return String(value).replace(/["\\\n\r]/g, "");
  }
})();
