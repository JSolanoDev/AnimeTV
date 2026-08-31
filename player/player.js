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
  let hasNextEpisode = params.get("hasNext") === "1";
  const isEmbeddedPlayer = window.parent && window.parent !== window;
  let art = null;
  let hls = null;
  let statusTimer = null;
  let startupTimer = null;
  let recoveryTimer = null;
  let hlsRecoveryTimer = null;
  let recoveryCount = 0;
  let networkRecoveryCount = 0;
  let mediaRecoveryCount = 0;
  let seekRecoveryUntil = 0;
  let lastProgressPosition = -1;
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
    networkRecoveryCount = 0;
    mediaRecoveryCount = 0;
    seekRecoveryUntil = 0;
    lastProgressPosition = -1;
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
    playerOptions.controls = [
      {
        name: "rewind-10",
        position: "left",
        index: 12,
        html: '<svg class="ztv-skip-icon" viewBox="0 0 32 32" fill="none" aria-hidden="true"><path class="ztv-skip-arrow" d="M7.3 10.2A10.8 10.8 0 1 1 5.2 17"></path><path class="ztv-skip-arrow" d="M7.2 4.8v5.6h5.6"></path><text class="ztv-skip-number" x="16" y="19.25" text-anchor="middle">10</text></svg>',
        tooltip: "Rewind 10 seconds",
        click: (_component, event) => {
          event.stopPropagation();
          seekBy(-10);
        }
      },
      {
        name: "forward-10",
        position: "left",
        index: 14,
        html: '<svg class="ztv-skip-icon" viewBox="0 0 32 32" fill="none" aria-hidden="true"><path class="ztv-skip-arrow" d="M24.7 10.2A10.8 10.8 0 1 0 26.8 17"></path><path class="ztv-skip-arrow" d="M24.8 4.8v5.6h-5.6"></path><text class="ztv-skip-number" x="16" y="19.25" text-anchor="middle">10</text></svg>',
        tooltip: "Forward 10 seconds",
        click: (_component, event) => {
          event.stopPropagation();
          seekBy(10);
        }
      }
    ];
    if (hasNextEpisode || isEmbeddedPlayer) {
      playerOptions.controls.push({
        name: "next-episode",
        position: "left",
        index: 16,
        html: '<svg class="ztv-next-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 4 10 8-10 8z"></path><path d="M19 5v14"></path></svg>',
        tooltip: "Next episode",
        click: (_component, event) => {
          event.stopPropagation();
          requestNextEpisode();
        }
      });
    }
    if (subtitleConfig) playerOptions.subtitle = subtitleConfig;

    art = new window.Artplayer(playerOptions);
    wireArtEvents();
    syncNextEpisodeControl();
    startMascot();
  }
  // ── Top-bar mascot ──────────────────────────────────────────────────────
  // Rotates through the mascot poses in the unused middle of the title bar, so
  // the bar looks different over time instead of showing one fixed image.
  //
  // Each pose may be an animated GIF or a still PNG: the loader tries .gif first
  // and falls back to .png for the same number, so whichever the files are, it
  // works with no code change. Poses that are missing entirely are dropped from
  // the rotation rather than showing a gap, and if NONE resolve the whole slot
  // removes itself so the bar is exactly as it was.
  //
  // Deliberately cheap: one setTimeout chain (no rAF loop), the next image is
  // preloaded so the swap never flashes a blank box, and the timer stops while
  // the tab is hidden.
  const MASCOT_BASE = "/mascot/";
  const mascotFile = (pose) => MASCOT_BASE + "frieren-full-" + pose + ".gif";
  // A short loop rather than a slideshow: she idles, waves, runs across the bar,
  // reads at the far end, and runs back. `move` drives the travel, and the
  // running poses are the only ones that move, so the sprite always faces the
  // way she is going. If frieren-full-running.gif turns out to face left, swap
  // its entry with the running-left one below.
  const MASCOT_SCRIPT = [
    { pose: "idle",          ms: 6000, move: null },
    { pose: "waving",        ms: 4200, move: null },
    { pose: "running-right", ms: 5200, move: "right" },
    { pose: "review",        ms: 8000, move: null },
    { pose: "waiting",       ms: 5000, move: null },
    { pose: "jumping",       ms: 3600, move: null },
    { pose: "running-left",  ms: 5200, move: "left" },
    { pose: "failed",        ms: 4000, move: null },
    { pose: "running",       ms: 4800, move: "right" },
    { pose: "idle",          ms: 5000, move: "left" }
  ];

  function startMascot() {
    const host = document.getElementById("ztvMascot");
    const img = document.getElementById("ztvMascotFrame");
    if (!host || !img) return;

    const drop = () => { try { host.remove(); } catch (err) { /* already gone */ } };
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      drop();
      return;
    }

    const missing = new Set();
    let index = -1;
    let timer = 0;
    let resolvedAny = false;
    let atRightEnd = false;

    // Preload a pose so the swap never flashes an empty box; null if absent.
    const resolvePose = (pose) => new Promise((done) => {
      const url = mascotFile(pose);
      const probe = new Image();
      probe.onload = () => done(url);
      probe.onerror = () => done(null);
      probe.src = url;
    });

    // How far she can travel: the slot's width less her own.
    const travel = () => Math.max(0, host.clientWidth - img.offsetWidth);

    const glideTo = (side, ms) => {
      img.style.transitionDuration = "180ms, " + ms + "ms";
      img.style.transform = "translateX(" + (side === "right" ? travel() : 0) + "px)";
      atRightEnd = side === "right";
    };

    const step = async () => {
      for (let tries = 0; tries < MASCOT_SCRIPT.length; tries++) {
        index = (index + 1) % MASCOT_SCRIPT.length;
        const beat = MASCOT_SCRIPT[index];
        if (missing.has(beat.pose)) continue;
        const url = await resolvePose(beat.pose);
        if (!url) { missing.add(beat.pose); continue; }
        resolvedAny = true;

        // Skip a run that would go nowhere (already at that end).
        const side = beat.move;
        const willMove = side && !((side === "right") === atRightEnd);

        // Cross-fade the pose, then start the walk once the new sprite is up.
        img.style.opacity = "0";
        window.setTimeout(() => {
          img.src = url;
          img.style.opacity = "1";
          if (willMove) glideTo(side, beat.ms - 300);
        }, 180);

        timer = window.setTimeout(step, beat.ms);
        return;
      }
      // Nothing resolved on a full pass: the sprites are not installed.
      if (!resolvedAny) drop();
    };

    step();

    document.addEventListener("visibilitychange", () => {
      window.clearTimeout(timer);
      if (!document.hidden && resolvedAny) timer = window.setTimeout(step, 800);
    });
  }

  function wireArtEvents() {
    if (!art) return;
    const video = art.video;
    if (video) {
      video.preload = "auto";
    }

    art.on("ready", () => {
      makeCustomControlsAccessible();
      syncNextEpisodeControl();
      send("ready", getStatus());
      send("loadedmetadata", getStatus());
      armStartupWatchdog();
      if (startAt > 0) {
        armSeekRecoveryGrace();
        try { art.seek = startAt; } catch (error) {}
      }
      if (forceSubtitles && art.subtitle) {
        try { art.subtitle.show = true; } catch (error) {}
      }
    });

    art.on("video:loadedmetadata", () => {
      send("loadedmetadata", getStatus());
      reportResolution();
    });
    art.on("video:durationchange", () => {
      send("durationchange", getStatus());
    });
    art.on("video:progress", () => {
      send("progress", getStatus());
    });
    art.on("video:loadeddata", () => {
      hideLoading();
      send("loadeddata", getStatus());
      reportResolution();
    });
    art.on("video:canplay", () => {
      clearStartupWatchdog();
      cancelScheduledRecovery();
      seekRecoveryUntil = 0;
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
      cancelScheduledRecovery();
      seekRecoveryUntil = 0;
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
    art.on("video:seeking", () => {
      armSeekRecoveryGrace();
    });
    art.on("video:ended", () => {
      send("complete", getStatus());
      stopStatusLoop();
    });
    art.on("video:timeupdate", () => {
      const position = video.currentTime || 0;
      if (position > lastProgressPosition + 0.2 || position < lastProgressPosition) {
        recoveryCount = 0;
        networkRecoveryCount = 0;
        mediaRecoveryCount = 0;
        lastProgressPosition = position;
      }
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
      // These catalog streams are on-demand episodes. Normal buffering is more
      // reliable than low-latency live tuning when a segment arrives slowly.
      lowLatencyMode: false,
      startFragPrefetch: true,
      backBufferLength: 60,
      maxBufferLength: 60,
      maxMaxBufferLength: 120,
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
        networkRecoveryCount += 1;
        if (networkRecoveryCount <= 3) {
          scheduleHlsReload(video, "network", networkRecoveryCount);
          return;
        }
        clearStartupWatchdog();
        showError("Network is too slow", "The stream kept timing out. Retry this source or choose another server.");
        send("error", "hls-network-fatal");
        return;
      }
      if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) {
        mediaRecoveryCount += 1;
        if (mediaRecoveryCount > 2) {
          clearStartupWatchdog();
          showError("Stream could not recover", "The video stream is not responding correctly. Try another source.");
          send("error", "hls-media-fatal");
          return;
        }
        try {
          hls.recoverMediaError();
          const playAttempt = video.play?.();
          if (playAttempt && typeof playAttempt.catch === "function") playAttempt.catch(() => {});
        } catch (error) {
          scheduleHlsReload(video, "media", mediaRecoveryCount);
        }
        return;
      }
      clearStartupWatchdog();
      showError("HLS stream failed", "The HLS stream could not be loaded. Try another source.");
      send("error", "hls-fatal");
    });
  }

  function scheduleHlsReload(video, reason, attempt) {
    if (hlsRecoveryTimer) return;
    const activeHls = hls;
    showLoading();
    hlsRecoveryTimer = setTimeout(() => {
      hlsRecoveryTimer = null;
      if (!activeHls || activeHls !== hls || !video || elements.error.hidden === false) return;
      try {
        activeHls.stopLoad();
        activeHls.startLoad(video.currentTime || -1);
        const playAttempt = video.play?.();
        if (playAttempt && typeof playAttempt.catch === "function") playAttempt.catch(() => {});
        send("recover", { reason, count: attempt, ...getStatus() });
      } catch (error) {
        console.warn("[ZenkaiPlayer] HLS reload failed", error);
      }
    }, Math.min(250 * Math.max(1, attempt), 1000));
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
      duration: playableDuration(video),
      buffer: bufferedEnd(video),
      paused: video.paused,
      muted: video.muted,
      volume: video.volume,
      rate: video.playbackRate
    };
  }

  function playableDuration(video) {
    const duration = Number(video?.duration);
    if (Number.isFinite(duration) && duration > 0) return duration;
    try {
      const end = video?.seekable?.length
        ? Number(video.seekable.end(video.seekable.length - 1))
        : 0;
      return Number.isFinite(end) && end > 0 ? end : 0;
    } catch (error) {
      return 0;
    }
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
    if (!data?.vcmd) return;
    const command = data.vcmd;
    const value = data.val;
    if (command === "hasNext") {
      hasNextEpisode = Boolean(value);
      syncNextEpisodeControl();
      return;
    }
    if (!art?.video) return;
    const video = art.video;
    if (command === "play") video.play?.();
    if (command === "pause") video.pause?.();
    if (command === "seek") {
      armSeekRecoveryGrace();
      art.seek = Math.max(0, Number(value) || 0);
    }
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
      armSeekRecoveryGrace();
      art.seek = nextTime;
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
    const seekGraceRemaining = seekRecoveryUntil - Date.now();
    if (seekGraceRemaining > 0) {
      recoveryTimer = setTimeout(() => {
        recoveryTimer = null;
        scheduleRecovery("seek-timeout");
      }, seekGraceRemaining + 100);
      return;
    }
    recoveryTimer = setTimeout(() => {
      recoveryTimer = null;
      const currentVideo = art?.video;
      if (!currentVideo || bufferedAhead(currentVideo) > 2 || elements.error.hidden === false) return;
      if (!currentVideo.paused && currentVideo.readyState >= 3) return;
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

  function armSeekRecoveryGrace() {
    seekRecoveryUntil = Date.now() + 8000;
    cancelScheduledRecovery();
  }

  function cancelScheduledRecovery() {
    if (recoveryTimer) clearTimeout(recoveryTimer);
    recoveryTimer = null;
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
    if (window.parent && window.parent !== window) {
      send("back", getStatus());
      return;
    }
    if (window.history.length > 1) {
      window.history.back();
    } else {
      window.location.href = "/";
    }
  }

  function makeCustomControlsAccessible() {
    ["rewind-10", "forward-10", "next-episode"].forEach((name) => {
      const control = elements.player.querySelector(`.art-control-${name}`);
      if (!control || control.dataset.keyboardReady === "1") return;
      control.dataset.keyboardReady = "1";
      control.setAttribute("role", "button");
      control.setAttribute("tabindex", "0");
      control.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.stopPropagation();
        control.click();
      });
    });
  }

  function syncNextEpisodeControl() {
    const control = elements.player.querySelector(".art-control-next-episode");
    if (!control) return;
    control.classList.toggle("is-disabled", !hasNextEpisode);
    control.setAttribute("aria-disabled", hasNextEpisode ? "false" : "true");
    control.setAttribute("aria-label", hasNextEpisode ? "Next episode" : "No next episode");
  }

  function requestNextEpisode() {
    if (!hasNextEpisode) return;
    send("next", getStatus());
  }

  function destroyHls() {
    if (!hls) return;
    try { hls.destroy(); } catch (error) {}
    hls = null;
  }

  function destroyPlayer() {
    stopStatusLoop();
    clearStartupWatchdog();
    cancelScheduledRecovery();
    if (hlsRecoveryTimer) clearTimeout(hlsRecoveryTimer);
    hlsRecoveryTimer = null;
    destroyHls();
    if (!art) return;
    try { art.destroy(false); } catch (error) {}
    art = null;
  }

  function cssUrl(value) {
    return String(value).replace(/["\\\n\r]/g, "");
  }
})();
