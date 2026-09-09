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
  // Valid sources for this episode, current one included. Anything above 1 means a
  // real alternative exists to switch to.
  const episodeSourceCount = Math.max(0, Number(params.get("sources") || 0));
  // Skip segments arrive per episode as "start,end" in seconds, decimals allowed.
  // Generic on purpose: adding "recap" later means adding one entry to SEGMENT_DEFS
  // and one param, nothing else. episodeKey stamps which episode they belong to so a
  // late postMessage for the PREVIOUS episode cannot apply to this one.
  const SEGMENT_DEFS = [
    { key: "intro", label: "Skip Opening" },
    { key: "outro", label: "Skip Ending" }
  ];
  let segments = parseSegmentsFromParams(params);
  let segmentsEpisodeKey = String(params.get("episodeKey") || params.get("episode") || "");
  let activeSegmentKey = null;
  let skipLayer = null;
  let skipButton = null;
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
  let artworkFrameCaptured = false;
  // Streams report their renditions once, in HLS MANIFEST_PARSED. The phone
  // options sheet is built from this list, so an empty array means "this stream
  // has no selectable quality" - never a fabricated ladder.
  let hlsLevels = [];
  let sheet = null;

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
    backdrop: document.getElementById("playerBackdrop"),
    chromeToggle: document.getElementById("chromeToggle"),
    floatingLabel: document.getElementById("floatingLabel")
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
  wireChromeToggle();
  elements.retry.addEventListener("click", () => {
    hideError();
    initPlayer();
  });

  window.addEventListener("message", onParentCommand);
  window.addEventListener("keydown", onKeydown, true);
  // The "..." control is CSS-hidden above 760px, where the desktop gear takes
  // over. Rotating a phone or widening a window while the sheet is open would
  // otherwise leave it stranded with no way back to it.
  if (window.matchMedia) {
    const phone = window.matchMedia("(max-width: 760px)");
    const onWidthChange = (event) => { if (!event.matches) closeOptionsSheet(); };
    if (phone.addEventListener) phone.addEventListener("change", onWidthChange);
    else if (phone.addListener) phone.addListener(onWidthChange);
  }
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

  // ── Collapsible title bar ───────────────────────────────────────────────
  // The bar is worth having when you arrive and in the way once you are
  // watching, so it collapses on demand and the choice is remembered. Storage
  // is wrapped because private windows and blocked site data make it throw.
  const CHROME_HIDDEN_KEY = "ztv:player-chrome-hidden";

  // "Season 3 Episode 10" -> "S3 · E10". The parent sends the long form for the
  // title bar; the floating strip has room for neither it nor a second line.
  function shortEpisodeLabel() {
    const seasonEpisode = episode.match(/season\s*(\d+)[^\d]*episode\s*(\d+)/i);
    if (seasonEpisode) return `S${seasonEpisode[1]} · E${seasonEpisode[2]}`;
    const episodeOnly = episode.match(/episode\s*(\d+)/i);
    return episodeOnly ? `E${episodeOnly[1]}` : "";
  }

  function wireChromeToggle() {
    const { chromeToggle, floatingLabel } = elements;
    if (!chromeToggle) return;

    const episodeSlot = document.getElementById("floatingEpisode");
    const titleSlot = document.getElementById("floatingTitle");
    if (episodeSlot) episodeSlot.textContent = shortEpisodeLabel();
    if (titleSlot) titleSlot.textContent = title === "ZenkaiTV Video" ? "" : title;

    let isHidden = true;
    const apply = (hidden, persist) => {
      isHidden = hidden;
      document.body.classList.toggle("ztv-chrome-hidden", hidden);
      chromeToggle.setAttribute("aria-expanded", hidden ? "false" : "true");
      chromeToggle.setAttribute("aria-label", hidden ? "Show the title bar" : "Hide the title bar");
      if (floatingLabel) floatingLabel.hidden = !hidden;
      if (!persist) return;
      try { localStorage.setItem(CHROME_HIDDEN_KEY, hidden ? "1" : "0"); }
      catch (error) { /* storage unavailable - the toggle still works this session */ }
    };

    // Desktop opens with the full bar - there is room for the title, the mascot
    // and the wordmark, so that is the better first impression. Only an explicit
    // collapse is remembered.
    let stored = false;
    try { stored = localStorage.getItem(CHROME_HIDDEN_KEY) === "1"; }
    catch (error) { stored = false; }

    // A phone gets the compact strip instead: there is no room for the full bar,
    // and the controls lock sits in the top-right corner, so the toggle would
    // land on top of it. The control goes away there and the bar stays
    // collapsed - back and the compact label already cover what it was for. The
    // stored preference is left untouched, so a desktop-sized window still opens
    // the bar if that is what was chosen there.
    const phone = window.matchMedia ? window.matchMedia("(max-width: 760px)") : null;
    const applyForWidth = () => {
      const onPhone = Boolean(phone?.matches);
      chromeToggle.hidden = onPhone;
      apply(onPhone ? true : stored, false);
    };
    applyForWidth();
    if (phone?.addEventListener) phone.addEventListener("change", applyForWidth);
    else if (phone?.addListener) phone.addListener(applyForWidth);
    // The media-query change event does not always arrive when the viewport is
    // resized programmatically, and rotating a phone to landscape crosses this
    // breakpoint. resize is cheap here and covers both.
    window.addEventListener("resize", applyForWidth);

    // One button, both directions - it never moves, so the same press point
    // opens and closes the bar.
    chromeToggle.addEventListener("click", () => {
      stored = !isHidden;
      apply(stored, true);
    });
  }

  // ── Line the chrome up with the picture, not the player box ──────────────
  // object-fit: contain means the video rarely fills its container: whenever the
  // stream's ratio differs from the player's there are black bars down the sides
  // (or top and bottom). The chrome was anchored to the container, so on a wide
  // window the title and the wordmark sat out on that black instead of on the
  // image - measured 156px of it either side at 1200x500.
  //
  // The contained rect cannot be expressed in CSS, so it is computed here and
  // published as two custom properties the stylesheet anchors to.
  function syncPictureInsets() {
    const root = document.documentElement;
    const video = art?.video;
    const box = video?.getBoundingClientRect();
    // cover/fill leave no bars, so there is nothing to inset by.
    const contained = !document.body.classList.contains("fit-cover")
      && !document.body.classList.contains("fit-fill");
    if (!video || !box?.width || !box?.height || !video.videoWidth || !video.videoHeight || !contained) {
      root.style.setProperty("--ztv-pillar", "0px");
      root.style.setProperty("--ztv-letter", "0px");
      return;
    }
    const scale = Math.min(box.width / video.videoWidth, box.height / video.videoHeight);
    const pillar = Math.max(0, Math.round((box.width - video.videoWidth * scale) / 2));
    const letter = Math.max(0, Math.round((box.height - video.videoHeight * scale) / 2));
    root.style.setProperty("--ztv-pillar", `${pillar}px`);
    root.style.setProperty("--ztv-letter", `${letter}px`);
  }

  function watchPictureInsets() {
    const player = art?.template?.$player;
    if (!player) return;
    syncPictureInsets();
    // The bars move whenever the box changes shape - resize, rotate, fullscreen,
    // or the stream switching to a rendition with a different ratio.
    if (typeof ResizeObserver === "function") {
      new ResizeObserver(syncPictureInsets).observe(player);
    } else {
      window.addEventListener("resize", syncPictureInsets);
    }
    art.on("video:loadedmetadata", syncPictureInsets);
    art.on("video:resize", syncPictureInsets);
  }

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
      // Web fullscreen ("fill screen") removed: it only stretches the video inside
      // the page, which on this layout looks almost identical to real fullscreen
      // and confused the two buttons sitting next to each other. Chromecast takes
      // its place on the right of the control bar.
      fullscreenWeb: false,
      hotkey: true,
      mutex: true,
      playsInline: true,
      // Chromium owns Chromecast through the control below. Enabling ArtPlayer's
      // native remote-playback control there exposes a second device route and can
      // make the same receiver appear twice. Keep AirPlay only where it is native.
      airplay: /\bSafari\//i.test(navigator.userAgent)
        && !/\b(?:Chrome|CriOS|Edg|OPR|Android)\b/i.test(navigator.userAgent),
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
        html: '<svg class="ztv-skip-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path class="ztv-skip-arrow" d="M9 14 4 9l5-5"></path><path class="ztv-skip-arrow" d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"></path></svg><span class="ztv-skip-value" aria-hidden="true">10s</span>',
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
        html: '<svg class="ztv-skip-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path class="ztv-skip-arrow" d="m15 14 5-5-5-5"></path><path class="ztv-skip-arrow" d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"></path></svg><span class="ztv-skip-value" aria-hidden="true">10s</span>',
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
    // Phone-only overflow. The bar keeps transport + volume + fullscreen; every
    // secondary control that the <=760px rules hide lives behind this one button
    // instead of being crammed back onto the row. CSS (not a matchMedia check at
    // construction time) decides when it shows, so rotating a phone or resizing
    // a window switches between the sheet and the desktop gear with no re-init.
    playerOptions.controls.push({
      name: "ztv-more",
      position: "right",
      index: 35,
      html: '<svg class="ztv-more-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="2"></circle><circle cx="12" cy="12" r="2"></circle><circle cx="12" cy="19" r="2"></circle></svg>',
      tooltip: "More options",
      click: (_component, event) => {
        event.stopPropagation();
        toggleOptionsSheet();
      }
    });
    if (subtitleConfig) playerOptions.subtitle = subtitleConfig;

    // How long the control bar lingers after the last interaction. ArtPlayer's
    // default is 3000ms, which is what made the volume feel slow to go away -
    // the panel itself is hover-driven and fades in 200ms, so the wait was
    // always the bar it sits in. Measured: opacity held at 1 until ~2700ms.
    // 1800ms is noticeably quicker while still leaving time to move between
    // controls. Static, so it must be set before the instance is constructed.
    window.Artplayer.CONTROL_HIDE_TIME = 1800;

    // Development logging. The lifecycle chatter is localhost-only; real failures
  // always reach console.error, because a silently swallowed Cast error is what
  // made this impossible to diagnose in the first place.
  // Cast tracing. Localhost always, and on the real site when it is asked for -
  // ?castdebug=1 on the page, or localStorage ztv:cast-debug=1, which survives the
  // navigations a Cast test involves. This gate is why the v683 instrumentation
  // produced no evidence on the one device that could produce it: every
  // RemotePlayer listener and every media-session sample ran on zenkaitv.com and
  // printed nothing, so the real-device test came back with nothing to read.
  const CAST_DEV = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname)
    || params.get("castdebug") === "1"
    || (() => { try { return localStorage.getItem("ztv:cast-debug") === "1"; } catch (error) { return false; } })();
  const CAST_SDK = "https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1";
  let castInitState = "idle";
  let castInitStarted = false;
  let castReceiverAppId = "";
  // Media-load telemetry, surfaced through snapshot() so a failure can be read
  // out of DevTools instead of being reconstructed from console scrollback.
  let castLoadCalled = false;
  let castLoadResult = "not-called";
  let castLoadError = null;
  let castLastUrlType = "";
  let castLastContentType = "";
  // HLS packaging, and the Cast fields derived from it. Set only on real evidence.
  let castHlsPackaging = "";
  let castHlsSegmentFormat = "";
  let castHlsVideoSegmentFormat = "";
  // Receiver-side truth, filled in by the RemotePlayer listeners below.
  let remotePlayer = null;
  let remoteController = null;
  let lastReceiverIdleReason = null;
  let lastReceiverMediaError = null;
  let mediaSessionSeenAt = null;
  // Codec compatibility for the CURRENTLY SELECTED source. We never substitute a
  // different provider - if the chosen one cannot be decoded by the receiver we
  // say so and leave the choice to the viewer.
  let castDetectedCodec = "";
  let castCodecMethod = "";
  let castCodecResult = "not-run";
  let castBlockedForCodec = false;
  const castCodecCache = new Map();

  // A Cast load that the receiver ACCEPTS can still never play. On the Hisense
  // 65U8K the Default Media Receiver took an AV1 fMP4/CMAF ladder, resolved
  // loadMedia() successfully, and then sat on its loading screen indefinitely -
  // no error, no state change, nothing for the sender to react to. Treating the
  // resolved promise as success is what left the TV stuck forever, so every
  // attempt is now watched against a deadline and abandoned if it never reaches
  // real playback.
  //
  // 15s is deliberately generous: a cold manifest + init segment + first media
  // segment measures 2-4s in the browser, so this leaves roughly 4x headroom for
  // a TV on wifi while still being a wait somebody will actually sit through. A
  // receiver that reports IDLE/ERROR is abandoned at once rather than waiting the
  // clock out.
  const CAST_PLAYBACK_DEADLINE_MS = 15000;
  const CAST_AV1_FALLBACK_DEADLINE_MS = 6500;
  const CAST_PLAYBACK_PROGRESS_SECONDS = 0.15;
  const CAST_PLAYBACK_CONFIRM_SECONDS = 3;
  const CAST_PLAYBACK_STALL_GRACE_MS = 3200;
  // The parent frame owns the source list. If it does not answer in this long we
  // cast the source we were opened with and nothing else, which is exactly the
  // old behaviour - the ladder is an enhancement, never a prerequisite.
  const CAST_CANDIDATE_REPLY_MS = 7000;
  // Bumped per attempt. Every async watcher captures it and bails the moment it
  // no longer matches, so a late callback from an abandoned attempt can never
  // resolve, abort or report on behalf of the current one.
  let castAttemptSeq = 0;
  let castAttempts = [];
  let castCandidatesCache = null;
  let castLadderRunning = false;
  let castSessionStarting = false;
  let castSessionStopping = false;
  let castPlaybackConfirmed = false;

  function castLog(...parts) {
    if (CAST_DEV) console.log("[Cast]", ...parts);
  }

  // Enum values are read back OFF the live SDK rather than hardcoded, so these
  // names always match whatever framework version gstatic actually served.
  function enumName(namespace, value) {
    try {
      for (const [key, candidate] of Object.entries(namespace || {})) {
        if (candidate === value) return key;
      }
    } catch (error) { /* fall through */ }
    return String(value);
  }

  function castContext() {
    try { return window.cast?.framework?.CastContext?.getInstance?.() || null; }
    catch (error) { return null; }
  }

  function castStateNow() {
    const ctx = castContext();
    if (!ctx) return "NO_SDK";
    try { return enumName(window.cast.framework.CastState, ctx.getCastState()); }
    catch (error) { return "UNKNOWN"; }
  }

  function sessionStateNow() {
    const ctx = castContext();
    if (!ctx) return "NO_SDK";
    try { return enumName(window.cast.framework.SessionState, ctx.getSessionState()); }
    catch (error) { return "UNKNOWN"; }
  }

  // Loaded ONCE, and __onGCastApiAvailable is defined BEFORE the script tag is
  // added - that is the contract the sender SDK documents, and doing it the other
  // way round (which the plugin did, on click) means the callback can be missed
  // entirely and nothing ever knows whether a receiver exists.
  function initCastFramework() {
    if (!window.isSecureContext || !window.chrome || /\b(?:Firefox|OPR)\//i.test(navigator.userAgent)) {
      castInitState = "unsupported-browser";
      castLog("unsupported browser or insecure context - not loading the SDK");
      return;
    }

    const configureContext = () => {
      if (!window.cast?.framework) {
        castInitState = "framework-missing";
        console.error("[Cast] cast.framework missing despite loadCastFramework=1");
        return;
      }
      castLog("framework available");
      castLog("initialization starting");
      try {
        castReceiverAppId = window.chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID;
        const ctx = window.cast.framework.CastContext.getInstance();
        // setOptions and framework listeners are document singletons. initPlayer()
        // can run again after Retry/source recovery; registering them each time is
        // what produced duplicate receiver entries in Chrome's chooser.
        if (!window.__ZENKAI_CAST_CONTEXT_CONFIGURED__) {
          ctx.setOptions({
            receiverApplicationId: castReceiverAppId,
            autoJoinPolicy: window.chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED
          });
          ctx.addEventListener(window.cast.framework.CastContextEventType.CAST_STATE_CHANGED, (event) => {
            const name = enumName(window.cast.framework.CastState, event.castState);
            castLog("state:", name);
            syncCastControl(name);
            syncCastStopControl();
          });
          ctx.addEventListener(window.cast.framework.CastContextEventType.SESSION_STATE_CHANGED, (event) => {
            const name = enumName(window.cast.framework.SessionState, event.sessionState);
            castLog("session:", name);
            if (name === "SESSION_STARTED" || name === "SESSION_RESUMED") {
              castSessionStopping = false;
              initRemotePlayer();
              window.setTimeout(() => {
                captureReceiverStatus();
                syncCastControl(castStateNow());
                syncCastStopControl();
              }, 0);
            } else if (name === "SESSION_ENDING") {
              castSessionStopping = true;
              syncCastStopControl();
            } else if (name === "SESSION_ENDED") {
              // Cancel any in-flight media watcher without disconnecting a newer
              // session that may already be starting.
              castSessionStopping = false;
              castPlaybackConfirmed = false;
              castAttemptSeq++;
              castLadderRunning = false;
              lastReceiverIdleReason = null;
              lastReceiverMediaError = null;
              mediaSessionSeenAt = null;
              syncCastControl(castStateNow());
              syncCastStopControl();
            }
          });
          window.__ZENKAI_CAST_CONTEXT_CONFIGURED__ = true;
        }
        initRemotePlayer();
        castInitState = "ready";
        castLog("initialization complete", { receiverApplicationId: castReceiverAppId, castState: castStateNow() });
        syncCastControl(castStateNow());
        syncCastStopControl();
      } catch (error) {
        castInitState = "init-failed";
        console.error("[Cast] initialization failed", error);
      }
    };

    if (window.cast?.framework && window.chrome?.cast?.media) {
      castInitStarted = true;
      configureContext();
      return;
    }
    if (castInitStarted) return;
    castInitStarted = true;
    castInitState = "loading-sdk";

    const existingScript = document.querySelector("script[data-zenkai-cast-sdk]");
    if (existingScript) {
      existingScript.addEventListener("load", () => configureContext(), { once: true });
      return;
    }

    window.__onGCastApiAvailable = (available, reason) => {
      castLog("SDK callback received", { available, reason });
      if (!available) {
        castInitState = "sdk-unavailable";
        console.error("[Cast] SDK reported unavailable", { reason });
        return;
      }
      configureContext();
    };
    const script = document.createElement("script");
    script.src = CAST_SDK;
    script.async = true;
    script.dataset.zenkaiCastSdk = "1";
    script.onerror = () => {
      castInitState = "sdk-load-error";
      console.error("[Cast] failed to load", CAST_SDK, "- check CSP script-src allows www.gstatic.com");
    };
    document.head.appendChild(script);
  }

  // Reflects availability on the button instead of pretending a device is there.
  function syncCastControl(stateName) {
    const control = art?.template?.$player?.querySelector?.(".art-control-chromecast");
    if (!control) return;
    control.classList.toggle("is-cast-connected", stateName === "CONNECTED");
    control.classList.toggle("is-cast-connecting", stateName === "CONNECTING");
    control.classList.toggle("is-cast-unavailable", stateName === "NO_DEVICES_AVAILABLE");
  }

  function syncCastStopControl() {
    const control = art?.template?.$player?.querySelector?.(".art-control-chromecast-stop");
    if (!control) return;
    const visible = castPlaybackConfirmed && Boolean(castSession());
    control.classList.toggle("is-visible", visible);
    control.classList.toggle("is-stopping", visible && castSessionStopping);
    control.setAttribute("aria-hidden", visible ? "false" : "true");
  }

  async function stopConfirmedCast() {
    // A connected origin-scoped session is not proof that this episode is on the
    // TV. Only watchCastPlayback() may enable this action after real progress.
    if (!castPlaybackConfirmed || castSessionStopping) return;
    const ctx = castContext();
    if (!ctx || !castSession()) {
      castPlaybackConfirmed = false;
      syncCastStopControl();
      return;
    }

    castSessionStopping = true;
    castAttemptSeq++;
    castLadderRunning = false;
    syncCastStopControl();
    try {
      await Promise.resolve(ctx.endCurrentSession(true));
      castPlaybackConfirmed = false;
      syncCastStopControl();
      if (art) art.notice.show = "Casting stopped";
    } catch (error) {
      castSessionStopping = false;
      console.error("[Cast] could not stop the confirmed session", error);
      syncCastStopControl();
      if (art) art.notice.show = "Could not stop casting - try again";
      return;
    }

    // SESSION_ENDED normally clears the transition. If a receiver disappears
    // without the final event, recover the button from the live media session.
    window.setTimeout(() => {
      if (!castSessionStopping) return;
      castSessionStopping = false;
      castPlaybackConfirmed = Boolean(castSession() && castMedia());
      syncCastStopControl();
    }, 3000);
  }

  // Stage 2 of three. Discovery (stage 1) is Chrome's job, and media delivery
  // (stage 3) happens on the receiver - each gets its own message rather than one
  // catch-all about the network.
  async function startCastSession() {
    const ctx = castContext();
    if (!ctx) {
      console.error("[Cast] requestSession skipped - no CastContext", { castInitState });
      if (art) art.notice.show = castInitState === "loading-sdk"
        ? "Cast is still starting up - try again in a moment"
        : "Casting is unavailable in this browser";
      return;
    }
    if (castSessionStopping) return;
    if (castSessionStarting) {
      castLog("session request already in progress - ignoring duplicate click");
      return;
    }
    castSessionStarting = true;
    try {
      const before = { castState: castStateNow(), sessionState: sessionStateNow() };
      let session = castSession();
      castLog(session ? "reusing current session" : "requestSession from click", before);
      // Discovery found nothing. That is NOT a session failure, and saying so sends
      // people to debug their Wi-Fi when the SDK simply has no receiver to offer.
      if (!session && before.castState === "NO_DEVICES_AVAILABLE") {
        console.error("[Cast] no devices available", { ...before, receiverApplicationId: castReceiverAppId });
        if (art) art.notice.show = "No Chromecast devices found";
        return;
      }
      // Resolve the Cast ladder and inspect the selected manifest while Chrome's
      // device picker is open. Both operations were previously started only after
      // a TV was chosen, adding several seconds of a blank receiver screen.
      const preparation = Promise.allSettled([
        requestCastCandidates(),
        detectCastVideoCodec(castMediaUrl(), castContentType())
      ]);
      if (!session) {
        try {
          await ctx.requestSession();
        } catch (error) {
          // The exact SDK value, not a guess. chrome.cast.ErrorCode members are strings
          // like "cancel" / "receiver_unavailable" / "session_error"; requestSession can
          // also reject with a bare string.
          const code = String(error?.code ?? error?.description ?? error ?? "");
          console.error("[Cast] requestSession failed", {
            error,
            code,
            message: error?.message ?? error?.description,
            castState: castStateNow(),
            sessionState: sessionStateNow(),
            receiverApplicationId: castReceiverAppId
          });
          if (!art) return;
          const lower = code.toLowerCase();
          if (lower.includes("cancel")) { art.notice.show = ""; return; }
          if (lower.includes("receiver_unavailable") || lower.includes("unavailable")) {
            art.notice.show = "No Chromecast devices found";
            return;
          }
          if (lower.includes("timeout")) { art.notice.show = "The Chromecast did not respond - try again"; return; }
          if (lower.includes("extension")) { art.notice.show = "Chrome cannot reach its Cast support"; return; }
          art.notice.show = `Couldn't start the Cast session (${code || "unknown"})`;
          return;
        }
        session = castSession();
      }
      await preparation;
      if (!session) {
        console.error("[Cast] requestSession resolved without a current CastSession");
        if (art) art.notice.show = "The Chromecast session did not finish connecting";
        return;
      }
      initRemotePlayer();
      castLog("session established", { castState: castStateNow(), sessionState: sessionStateNow() });
      await loadCastMedia();
    } finally {
      castSessionStarting = false;
    }
  }

  // Stage 3. A failure here is about the MEDIA, never about discovery.
  // What the receiver is being asked to fetch. Extension alone is unreliable here
  // (our proxy path has none), so the declared stream type wins when we have it.
  function classifyCastUrl(url, typeHint = "") {
    if (!url) return "NONE";
    if (/^blob:/i.test(url)) return "BLOB";
    if (/^data:/i.test(url)) return "DATA";
    if (/^file:/i.test(url)) return "FILE";
    try {
      const parsed = new URL(url);
      // A Chromecast is a SEPARATE DEVICE. It resolves these against itself, not
      // against this machine, so they can never work no matter how correct the
      // rest of the request is.
      if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?)$/i.test(parsed.hostname)) return "LOCAL";
    } catch (error) { return "OTHER"; }
    if (/mpegurl/i.test(typeHint) || streamType(url, typeHint) === "m3u8") return "HLS";
    let probe = url;
    try {
      probe = new URL(url, window.location.origin).searchParams.get("url") || url;
    } catch (error) { /* use the candidate URL */ }
    const clean = probe.split("?")[0].split("#")[0].toLowerCase();
    if (clean.endsWith(".m3u8")) return "HLS";
    if (clean.endsWith(".mpd")) return "DASH";
    if (clean.endsWith(".mp4") || clean.endsWith(".m4v")) return "MP4";
    return "OTHER";
  }

  // The upstream the proxy is fronting, when there is one.
  function castUpstreamUrl() {
    try { return new URL(sourceUrl, window.location.origin).searchParams.get("url") || ""; }
    catch (error) { return ""; }
  }

  // Host only - never the full URL, which can carry signed parameters.
  function castSourceLabel() {
    try {
      const upstream = castUpstreamUrl();
      if (upstream) return new URL(upstream).host + " (via /api/source)";
      return new URL(castMediaUrl()).host;
    } catch (error) { return "unknown"; }
  }

  // fourCC names in an fMP4 init segment. Video only - mp4a/ec-3 are audio and
  // must not decide the verdict.
  function codecFromFourCC(bytes) {
    let ascii = "";
    const limit = Math.min(bytes.length, 32768);
    for (let i = 0; i < limit; i++) {
      const b = bytes[i];
      ascii += (b > 31 && b < 127) ? String.fromCharCode(b) : ".";
    }
    if (ascii.includes("av01")) return "AV1";
    if (ascii.includes("hvc1") || ascii.includes("hev1")) return "HEVC";
    if (ascii.includes("avc1") || ascii.includes("avc3")) return "H.264";
    if (ascii.includes("vp09")) return "VP9";
    return "";
  }

  function av1CodecStringFromBytes(bytes) {
    const limit = Math.min(bytes.length - 6, 32768);
    for (let i = 0; i < limit; i++) {
      if (bytes[i] !== 0x61 || bytes[i + 1] !== 0x76 || bytes[i + 2] !== 0x31 || bytes[i + 3] !== 0x43) continue;
      // ISO/IEC 14496-15 AV1CodecConfigurationRecord: marker/version, then
      // profile+level, then tier+bit-depth flags. The short RFC 6381 spelling is
      // enough for a Cast HLS master playlist and avoids guessing the decoder.
      const profileAndLevel = bytes[i + 5];
      const tierAndDepth = bytes[i + 6];
      const profile = (profileAndLevel >> 5) & 0x07;
      const level = profileAndLevel & 0x1f;
      const tier = (tierAndDepth & 0x80) ? "H" : "M";
      const bitDepth = (tierAndDepth & 0x20) ? 12 : ((tierAndDepth & 0x40) ? 10 : 8);
      return `av01.${profile}.${String(level).padStart(2, "0")}${tier}.${String(bitDepth).padStart(2, "0")}`;
    }
    return "";
  }

  function codecFromCodecsAttribute(value) {
    const v = String(value || "").toLowerCase();
    if (v.includes("av01")) return "AV1";
    if (v.includes("hvc1") || v.includes("hev1")) return "HEVC";
    if (v.includes("avc1") || v.includes("avc3")) return "H.264";
    if (v.includes("vp09")) return "VP9";
    return "";
  }

  // Audio is reported, never acted on. It is here so a failed cast can say what
  // the receiver was asked to decode on both tracks instead of only the video.
  function audioCodecFrom(text) {
    const v = String(text || "").toLowerCase();
    if (v.includes("mp4a")) return "AAC";
    if (v.includes("ec-3") || v.includes("ec3")) return "E-AC3";
    if (v.includes("ac-3") || v.includes("ac3")) return "AC3";
    if (v.includes("opus")) return "Opus";
    if (v.includes("fLaC") || v.includes("flac")) return "FLAC";
    return "";
  }

  // Every probe below runs BEFORE loadMedia, while the TV already sits on the
  // launched receiver screen. An unbounded fetch here is indistinguishable from a
  // stuck cast: the loading screen stays up and loadMedia is never even called.
  // So all of them are bounded, and a slow probe degrades to "UNKNOWN" rather
  // than to a hang.
  const CAST_PROBE_TIMEOUT_MS = 6000;
  function castFetch(url, init) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), CAST_PROBE_TIMEOUT_MS);
    // The source proxy gives immutable segments and VOD manifests bounded cache
    // lifetimes. Let the sender warm those responses for the receiver instead of
    // forcing an identical second origin request immediately afterwards.
    return fetch(url, { cache: "default", ...init, signal: controller.signal })
      .finally(() => window.clearTimeout(timer));
  }

  async function detectHlsPackaging(text, url) {
    if (/#EXT-X-MAP/.test(text)) return { packaging: "FMP4", how: "EXT-X-MAP present" };
    const segLine = text.split("\n").find((l) => l.trim() && !l.startsWith("#"));
    if (!segLine) return { packaging: "UNKNOWN", how: "no segment lines" };
    let probe = segLine.trim();
    try {
      const abs = new URL(probe, url);
      probe = abs.searchParams.get("url") || abs.pathname;
    } catch (error) { /* use the raw line */ }
    const clean = String(probe).split("?")[0].split("#")[0].toLowerCase();
    if (clean.endsWith(".ts")) return { packaging: "MPEG2_TS", how: ".ts segment extension" };
    if (clean.endsWith(".m4s") || clean.endsWith(".mp4")) return { packaging: "FMP4", how: "fMP4 segment extension" };
    // The AnimeAV1 CDN names segments .html, so extension proves nothing - look.
    try {
      const segRes = await castFetch(new URL(segLine.trim(), url).href);
      if (!segRes.ok) return { packaging: "UNKNOWN", how: `segment HTTP ${segRes.status}` };
      const head = new Uint8Array((await segRes.arrayBuffer()).slice(0, 16));
      if (head[0] === 0x47) return { packaging: "MPEG2_TS", how: "0x47 TS sync byte" };
      const box = String.fromCharCode(head[4], head[5], head[6], head[7]);
      if (box === "styp" || box === "ftyp") return { packaging: "FMP4", how: `ISO-BMFF ${box} box` };
      return { packaging: "UNKNOWN", how: "segment head matched nothing" };
    } catch (error) {
      return { packaging: "UNKNOWN", how: "segment probe failed" };
    }
  }

  // Reads the media itself rather than trusting the provider name. Cheapest
  // reliable evidence first: a master playlist states CODECS outright, and an
  // fMP4 rendition names it in an init segment that is a couple of KB - far less
  // than pulling a 3MB media segment.
  async function detectCastVideoCodec(url, typeHint = "") {
    const key = `${segmentsEpisodeKey}|${typeHint}|${url}`;
    const cached = castCodecCache.get(key);
    if (cached) return cached;
    const out = {
      codec: "UNKNOWN", method: "not determined",
      codecString: "",
      audioCodec: "UNKNOWN",
      packaging: "UNKNOWN", packagingHow: "not determined",
      // A receiver treats a playlist with no ENDLIST and no PLAYLIST-TYPE as live.
      hasEndlist: null, playlistType: null
    };
    try {
      // A direct MP4 has no HLS manifest to inspect. Fetching it as text would
      // pull the whole episode through the Vercel proxy before Cast even starts.
      // The receiver can inspect the MP4 container itself, so leave it unknown.
      const declaredHls = /mpegurl/i.test(typeHint)
        || streamType(url, typeHint) === "m3u8"
        || castContentTypeFor(url, typeHint) === "application/x-mpegurl";
      if (!declaredHls) {
        out.method = "direct media; receiver inspects container";
        castCodecCache.set(key, out);
        return out;
      }
      const res = await castFetch(url);
      if (!res.ok) {
        out.method = `manifest HTTP ${res.status}`;
        return out;   // transient, not cached
      }
      const text = await res.text();
      const streamInf = text.match(/#EXT-X-STREAM-INF:[^\n]*/);
      if (streamInf) {
        const declared = (streamInf[0].match(/CODECS="([^"]+)"/i) || [])[1];
        const codec = codecFromCodecsAttribute(declared);
        if (codec) {
          out.codec = codec;
          out.codecString = declared || "";
          out.audioCodec = audioCodecFrom(declared) || "UNKNOWN";
          out.method = "HLS EXT-X-STREAM-INF CODECS";
          // FOLLOW the variant. Returning UNKNOWN here - which is what v683 did -
          // meant that for any ladder whose master playlist declares CODECS, the
          // fMP4 description was never attached at all: the whole point of that
          // change was skipped on exactly the streams most likely to need it, and
          // the receiver went back to parsing CMAF as MPEG-TS. One extra request
          // buys a real answer instead of a guess.
          const variantUri = (text.match(/#EXT-X-STREAM-INF:[^\n]*\n([^#\n][^\n]*)/) || [])[1];
          if (variantUri) {
            try {
              const variantUrl = new URL(variantUri.trim(), url).href;
              const variantRes = await castFetch(variantUrl);
              if (variantRes.ok) {
                const variantText = await variantRes.text();
                const pack = await detectHlsPackaging(variantText, variantUrl);
                out.packaging = pack.packaging;
                out.packagingHow = `variant: ${pack.how}`;
                // The master carries neither, so read them off the rendition that
                // will actually be played.
                out.hasEndlist = /#EXT-X-ENDLIST/.test(variantText);
                out.playlistType = (variantText.match(/#EXT-X-PLAYLIST-TYPE:(\w+)/) || [])[1] || "(none)";
              } else {
                out.packagingHow = `variant HTTP ${variantRes.status}`;
              }
            } catch (error) {
              out.packagingHow = "variant probe failed";
            }
          } else {
            out.packagingHow = "master playlist declared no variant URI";
          }
          castCodecCache.set(key, out);
          return out;
        }
      }
      const pack = await detectHlsPackaging(text, url);
      out.packaging = pack.packaging;
      out.packagingHow = pack.how;
      out.hasEndlist = /#EXT-X-ENDLIST/.test(text);
      out.playlistType = (text.match(/#EXT-X-PLAYLIST-TYPE:(\w+)/) || [])[1] || "(none)";
      const mapUri = (text.match(/#EXT-X-MAP:[^\n]*URI="([^"]+)"/) || [])[1];
      if (mapUri) {
        const initRes = await castFetch(new URL(mapUri, url).href);
        if (!initRes.ok) {
          out.method = `init segment HTTP ${initRes.status}`;
          return out;   // transient, not cached
        }
        const initBytes = new Uint8Array(await initRes.arrayBuffer());
        const codec = codecFromFourCC(initBytes);
        // Same bytes, no extra request: the init segment names both tracks.
        let initAscii = "";
        for (let i = 0; i < Math.min(initBytes.length, 32768); i++) {
          const b = initBytes[i];
          initAscii += (b > 31 && b < 127) ? String.fromCharCode(b) : ".";
        }
        out.audioCodec = audioCodecFrom(initAscii) || "UNKNOWN";
        out.codec = codec || "UNKNOWN";
        out.codecString = codec === "AV1" ? av1CodecStringFromBytes(initBytes) : "";
        out.method = codec ? "HLS EXT-X-MAP init segment" : "init segment carried no known fourCC";
        castCodecCache.set(key, out);
        return out;
      }
      out.method = "no CODECS attribute and no EXT-X-MAP";
      castCodecCache.set(key, out);
      return out;
    } catch (error) {
      out.method = "detection failed: " + String(error?.message ?? error).slice(0, 60);
      return out;
    }
  }

  // Receiver-side truth. Without this the only thing we could see was that the
  // media session vanished; these events say WHY.
  function initRemotePlayer() {
    if (remotePlayer || !window.cast?.framework?.RemotePlayer) return;
    try {
      remotePlayer = new window.cast.framework.RemotePlayer();
      remoteController = new window.cast.framework.RemotePlayerController(remotePlayer);
      const E = window.cast.framework.RemotePlayerEventType;
      const report = (name) => () => {
        castLog("remote player", {
          event: name,
          isConnected: remotePlayer.isConnected,
          isMediaLoaded: remotePlayer.isMediaLoaded,
          playerState: remotePlayer.playerState,
          currentTime: remotePlayer.currentTime,
          duration: remotePlayer.duration
        });
        if (remotePlayer.isMediaLoaded && !mediaSessionSeenAt) mediaSessionSeenAt = "remote player reported loaded";
        captureReceiverStatus();
      };
      for (const [key, name] of [["IS_CONNECTED_CHANGED", "IS_CONNECTED_CHANGED"], ["IS_MEDIA_LOADED_CHANGED", "IS_MEDIA_LOADED_CHANGED"], ["PLAYER_STATE_CHANGED", "PLAYER_STATE_CHANGED"], ["MEDIA_INFO_CHANGED", "MEDIA_INFO_CHANGED"], ["DURATION_CHANGED", "DURATION_CHANGED"]]) {
        if (E?.[key]) remoteController.addEventListener(E[key], report(name));
      }
      castLog("remote player instrumented");
    } catch (error) {
      console.warn("[Cast] RemotePlayer instrumentation failed", error);
    }
  }

  // idleReason is the receiver saying why it stopped - ERROR here would mean it
  // took the media and then could not play it.
  function captureReceiverStatus() {
    const media = castMedia();
    if (!media) {
      if (remotePlayer && !remotePlayer.isMediaLoaded) {
        castPlaybackConfirmed = false;
        syncCastStopControl();
      }
      return;
    }
    if (!mediaSessionSeenAt) mediaSessionSeenAt = new Date().toISOString();
    if (media.idleReason) lastReceiverIdleReason = String(media.idleReason);
    // Previously declared, surfaced in snapshot() and never written, so a hard
    // receiver-side failure still reported lastReceiverMediaError: null.
    const reportedError = media.customData?.error || media.error || null;
    if (reportedError) {
      lastReceiverMediaError = {
        code: reportedError.code ?? null,
        detailedErrorCode: reportedError.detailedErrorCode ?? null,
        reason: reportedError.reason ?? null
      };
    }
    const status = media.playerState ? String(media.playerState) : null;
    if (status) castLog("receiver playerState", status, "idleReason", media.idleReason ?? null);
    if (status && enumName(window.chrome?.cast?.media?.PlayerState, status) === "IDLE") {
      castPlaybackConfirmed = false;
    }
    syncCastStopControl();
  }

  // Diagnostic only - getMediaSession() does not necessarily appear synchronously,
  // so look again at intervals instead of concluding from one reading.
  function observeMediaSession(tag) {
    const at = [0, 250, 1000, 3000, 5000];
    for (const ms of at) {
      setTimeout(() => {
        const media = castMedia();
        captureReceiverStatus();
        castLog(`mediaSession @${ms}ms (${tag})`, {
          hasMediaSession: Boolean(media),
          playerState: media?.playerState ?? null,
          idleReason: media?.idleReason ?? null,
          remoteIsMediaLoaded: remotePlayer?.isMediaLoaded ?? null,
          remotePlayerState: remotePlayer?.playerState ?? null,
          remoteDuration: remotePlayer?.duration ?? null
        });
      }, ms);
    }
  }

  // Host only, never the query string - these URLs carry signed upstream targets
  // and referer hints that must not reach a console log or a bug report.
  function hostOnly(url) {
    try {
      const parsed = new URL(String(url || ""), window.location.origin);
      const inner = parsed.searchParams.get("url");
      if (inner) {
        try { return `${new URL(inner).hostname} (via ${parsed.pathname})`; }
        catch (error) { return parsed.hostname + parsed.pathname; }
      }
      return parsed.hostname;
    } catch (error) {
      return "(unparseable)";
    }
  }


  // Describes the media to the receiver. hlsSegmentFormat is the AUDIO segment
  // format and hlsVideoSegmentFormat the VIDEO one - they are two different fields
  // for two different tracks. Enum values are read off the live SDK so a build
  // that lacks them describes nothing rather than smuggling in string literals
  // the receiver may reject.
  function buildCastLoadRequest(candidate, detection) {
    let contentUrl = candidate.url;
    // AnimeAV1 serves a media playlist directly. Cast defaults an HLS stream
    // with no master CODECS attribute to H.264, even when its fMP4 init segment
    // actually declares AV1. Ask our proxy for a one-variant Cast-only master so
    // the receiver initializes the decoder that matches the media.
    if (detection.codec === "AV1" && detection.codecString && candidate.contentType === "application/x-mpegurl") {
      try {
        const parsed = new URL(candidate.url, window.location.origin);
        if (parsed.origin === window.location.origin && parsed.pathname === "/api/source") {
          const codecs = `${detection.codecString},mp4a.40.2`;
          parsed.searchParams.set("castCodecs", codecs);
          contentUrl = parsed.href;
        }
      } catch (error) { /* cast the original URL */ }
    }
    const media = new window.chrome.cast.media.MediaInfo(contentUrl, candidate.contentType);
    const SegFmt = window.chrome?.cast?.media?.HlsSegmentFormat;
    const VidFmt = window.chrome?.cast?.media?.HlsVideoSegmentFormat;
    const StreamType = window.chrome?.cast?.media?.StreamType;
    if (StreamType?.BUFFERED) media.streamType = StreamType.BUFFERED;
    castHlsSegmentFormat = "";
    castHlsVideoSegmentFormat = "";
    if (detection.packaging === "FMP4") {
      if (SegFmt?.FMP4) {
        media.hlsSegmentFormat = SegFmt.FMP4;
        castHlsSegmentFormat = String(SegFmt.FMP4);
      }
      if (VidFmt?.FMP4) {
        media.hlsVideoSegmentFormat = VidFmt.FMP4;
        castHlsVideoSegmentFormat = String(VidFmt.FMP4);
      }
    } else if (detection.packaging === "MPEG2_TS") {
      if (SegFmt?.TS) {
        media.hlsSegmentFormat = SegFmt.TS;
        castHlsSegmentFormat = String(SegFmt.TS);
      }
      if (VidFmt?.MPEG2_TS) {
        media.hlsVideoSegmentFormat = VidFmt.MPEG2_TS;
        castHlsVideoSegmentFormat = String(VidFmt.MPEG2_TS);
      }
    }
    try {
      const meta = new window.chrome.cast.media.GenericMediaMetadata();
      meta.title = title || "ZenkaiTV";
      if (episode) meta.subtitle = String(episode);
      if (poster) meta.images = [new window.chrome.cast.Image(poster)];
      media.metadata = meta;
    } catch (error) {
      console.warn("[Cast] metadata skipped", error);
    }
    const request = new window.chrome.cast.media.LoadRequest(media);
    const at = Number(art?.video?.currentTime || 0);
    request.currentTime = Number.isFinite(at) && at > 1 ? at : 0;
    request.autoplay = true;
    return request;
  }

  // Ask the parent for every source this episode could be cast from. The player
  // frame is opened with ONE src, so without this there is nothing to fall back
  // to. The parent answers from the same list the source picker renders, which is
  // what keeps the adult-source rules intact: a source that could not be picked
  // by hand cannot be reached by casting either.
  function requestCastCandidates() {
    if (castCandidatesCache) return Promise.resolve(castCandidatesCache);
    if (window.parent === window) return Promise.resolve([]);
    return new Promise((resolve) => {
      let done = false;
      const finish = (list) => {
        if (done) return;
        done = true;
        castCandidatesResolve = null;
        castCandidatesCache = Array.isArray(list) ? list : [];
        resolve(castCandidatesCache);
      };
      castCandidatesResolve = finish;
      window.setTimeout(() => finish([]), CAST_CANDIDATE_REPLY_MS);
      try {
        window.parent.postMessage(JSON.stringify({ vcmd: "castCandidates" }), "*");
      } catch (error) {
        finish([]);
      }
    });
  }

  // The ordered list of things to try. The source the viewer actually chose is
  // always first - casting must not silently play a different server than the one
  // on screen - and the rest only exist to rescue a stuck attempt.
  async function castCandidateLadder() {
    const own = {
      label: castSourceLabel() || "selected source",
      url: castMediaUrl(),
      contentType: castContentType()
    };
    const fromParent = await requestCastCandidates();
    // Identity is the UPSTREAM stream, not the proxy URL that wraps it. The frame
    // was opened with one spelling of /api/source?url=... and the parent builds
    // candidates with another (parameter order, a refererHost that is present on
    // one and not the other), so comparing whole URLs let the SAME stream enter
    // the ladder twice - and the duplicate would burn a second full deadline on a
    // source that had already failed.
    const identity = (value) => {
      try {
        const parsed = new URL(String(value || ""), window.location.origin);
        return parsed.searchParams.get("url") || parsed.href;
      } catch (error) {
        return String(value || "");
      }
    };
    const seen = new Set([identity(own.url)]);
    const ladder = [own];
    for (const entry of fromParent) {
      let absolute = "";
      try { absolute = new URL(String(entry?.url || ""), window.location.origin).href; }
      catch (error) { continue; }
      const id = identity(absolute);
      if (!absolute || seen.has(id)) continue;
      seen.add(id);
      ladder.push({
        label: String(entry.label || "alternate source"),
        url: absolute,
        contentType: castContentTypeFor(absolute, entry.type)
      });
    }
    return ladder;
  }

  // Watches what the RECEIVER is doing, which is the only thing that says whether
  // the cast worked. Polled rather than event-driven on purpose: the media session
  // does not exist yet when loadMedia() resolves, so there is nothing to attach an
  // update listener to at the one moment we need to start watching.
  function watchCastPlayback(deadlineMs, token, requestedStartTime = 0) {
    return new Promise((resolve) => {
      const PlayerState = window.chrome?.cast?.media?.PlayerState || {};
      const IdleReason = window.chrome?.cast?.media?.IdleReason || {};
      const startedAt = Date.now();
      // A media session can read IDLE for a moment right after loadMedia resolves,
      // before the receiver has moved on. Failing on that would abandon casts that
      // were about to work, so IDLE only counts once this much has passed - except
      // for idleReason ERROR, which is never transient.
      const IDLE_GRACE_MS = 2000;
      let timer = null;
      let lastState = "";
      const baselineTime = Math.max(0, Number(requestedStartTime) || 0);
      let lastTime = baselineTime;
      let lastProgressAt = 0;
      const stop = (outcome, detail) => {
        window.clearInterval(timer);
        resolve({ outcome, detail, waitedMs: Date.now() - startedAt, lastState, lastTime });
      };
      timer = window.setInterval(() => {
        if (token !== castAttemptSeq) return stop("superseded", "a newer attempt took over");
        const media = castMedia();
        const rawState = media?.playerState || remotePlayer?.playerState || "";
        const state = rawState ? enumName(PlayerState, rawState) : "";
        const idle = media?.idleReason ? enumName(IdleReason, media.idleReason) : "";
        if (state) lastState = state;
        if (idle) lastReceiverIdleReason = idle;
        const mediaTime = Number(media?.currentTime || 0);
        const remoteTime = Number(remotePlayer?.currentTime || 0);
        const now = Math.max(Number.isFinite(mediaTime) ? mediaTime : 0, Number.isFinite(remoteTime) ? remoteTime : 0);
        const sampledAt = Date.now();
        if (now > lastTime + 0.04) {
          lastTime = now;
          lastProgressAt = sampledAt;
        }
        const clockAdvanced = lastTime >= baselineTime + CAST_PLAYBACK_PROGRESS_SECONDS;
        const playbackActive = state === "PLAYING" || state === "BUFFERING";
        // A one-second AV1 burst is not a successful cast. Both tested receivers
        // can briefly decode the first fragment and then freeze, while continuing
        // to claim PLAYING. Keep the ladder alive until several seconds of media
        // have actually advanced so that failure can fall through to H.264.
        if (playbackActive && lastTime >= baselineTime + CAST_PLAYBACK_CONFIRM_SECONDS) {
          return stop("playing", `receiver advanced ${CAST_PLAYBACK_CONFIRM_SECONDS}s`);
        }
        // A receiver that is PAUSED past zero has decoded and rendered frames, so
        // the media is good even though it is not running right now.
        if (state === "PAUSED" && clockAdvanced) {
          return stop("playing", "receiver reported PAUSED past 0s");
        }
        if (playbackActive && clockAdvanced && lastProgressAt
          && sampledAt - lastProgressAt >= CAST_PLAYBACK_STALL_GRACE_MS) {
          return stop("stalled", `receiver clock stopped at ${lastTime.toFixed(2)}s`);
        }
        // IDLE after a load means the receiver is not going to play this. ERROR is
        // never transient, so act on it at once; the other reasons only count once
        // the grace has passed, so a momentary IDLE right after the load does not
        // abandon an attempt that was about to succeed.
        if (state === "IDLE") {
          if (idle === "ERROR") return stop("error", "receiver went IDLE with idleReason ERROR");
          if (Date.now() - startedAt >= IDLE_GRACE_MS) {
            return stop("error", `receiver went IDLE with idleReason ${idle || "(none reported)"}`);
          }
        }
        if (Date.now() - startedAt >= deadlineMs) {
          return stop("timeout", lastState
            ? `receiver stuck in ${lastState} for ${Math.round(deadlineMs / 1000)}s`
            : `receiver never reported a playback state within ${Math.round(deadlineMs / 1000)}s`);
        }
      }, 400);
    });
  }

  // Leaves the SESSION connected - only the media is dropped, so the next rung of
  // the ladder does not have to reconnect to the TV.
  function abortCastAttempt() {
    const media = castMedia();
    if (!media) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(); } };
      window.setTimeout(done, 2000);
      try {
        media.stop(new window.chrome.cast.media.StopRequest(), done, done);
      } catch (error) {
        done();
      }
    });
  }

  // One attempt, one candidate, no retries. Returns what the receiver did.
  async function attemptCast(session, candidate, token, hasFallback = false) {
    const kind = classifyCastUrl(candidate.url, candidate.contentType);
    if (kind === "NONE" || kind === "BLOB" || kind === "DATA" || kind === "FILE" || kind === "LOCAL") {
      return { outcome: "refused", detail: `url is ${kind}`, kind };
    }
    const detection = await detectCastVideoCodec(candidate.url, candidate.contentType);
    let request;
    try {
      request = buildCastLoadRequest(candidate, detection);
    } catch (error) {
      return { outcome: "build-threw", detail: String(error?.message ?? error), kind, detection };
    }
    castLog("attempt", {
      candidate: candidate.label,
      host: hostOnly(candidate.url),
      contentType: candidate.contentType,
      codec: detection.codec,
      container: detection.packaging,
      containerEvidence: detection.packagingHow,
      hasEndlist: detection.hasEndlist,
      playlistType: detection.playlistType,
      hlsSegmentFormat: castHlsSegmentFormat || "(not set)",
      hlsVideoSegmentFormat: castHlsVideoSegmentFormat || "(not set)"
    });
    let loaded;
    try {
      initRemotePlayer();
      await session.loadMedia(request);
      observeMediaSession(candidate.label);
      loaded = true;
    } catch (error) {
      return {
        outcome: "rejected",
        detail: String(error?.message ?? error?.code ?? error),
        code: error?.code ?? null,
        kind,
        detection
      };
    }
    if (token !== castAttemptSeq) return { outcome: "superseded", detail: "a newer attempt took over", kind, detection };
    // Accepted. Now find out whether it actually plays.
    const deadlineMs = detection.codec === "AV1" && hasFallback
      ? Math.min(CAST_PLAYBACK_DEADLINE_MS, CAST_AV1_FALLBACK_DEADLINE_MS)
      : CAST_PLAYBACK_DEADLINE_MS;
    const watched = await watchCastPlayback(deadlineMs, token, request.currentTime);
    return { ...watched, loaded, kind, detection, deadlineMs };
  }

  async function loadCastMedia() {
    const session = castSession();
    castPlaybackConfirmed = false;
    syncCastStopControl();
    castLoadCalled = false;
    castLoadResult = "not-called";
    castLoadError = null;
    castBlockedForCodec = false;
    castCodecResult = "not-run";
    if (!session) {
      castLoadResult = "no-session";
      console.error("[Cast] loadMedia skipped - no current session after connect");
      return;
    }
    // One ladder at a time. Without this, a second trigger (reconnect, episode
    // change) would race the first and both would fight over the same session.
    if (castLadderRunning) {
      castLog("ladder already running - ignoring duplicate trigger");
      return;
    }
    castLadderRunning = true;
    castAttempts = [];
    const token = ++castAttemptSeq;
    try {
      if (art) art.notice.show = "Preparing TV playback...";
      const ladder = await castCandidateLadder();
      if (art) art.notice.show = "Starting on your TV...";
      for (let index = 0; index < ladder.length; index++) {
        if (token !== castAttemptSeq) return;
        const candidate = ladder[index];
        castLastUrlType = classifyCastUrl(candidate.url, candidate.contentType);
        castLastContentType = candidate.contentType;
        castLoadCalled = true;
        castLoadResult = "pending";
        const result = await attemptCast(session, candidate, token, index < ladder.length - 1);
        if (token !== castAttemptSeq) return;
        castAttempts.push({
          rung: index + 1,
          of: ladder.length,
          episode: episode || "(none)",
          candidate: candidate.label,
          host: hostOnly(candidate.url),
          contentType: candidate.contentType,
          manifestType: result.detection?.method || "not-detected",
          codec: result.detection?.codec || "not-detected",
          audioCodec: result.detection?.audioCodec || "not-detected",
          container: result.detection?.packaging || "not-detected",
          containerEvidence: result.detection?.packagingHow || "not-detected",
          hasEndlist: result.detection?.hasEndlist ?? null,
          playlistType: result.detection?.playlistType ?? null,
          hlsSegmentFormat: castHlsSegmentFormat || "(not set)",
          hlsVideoSegmentFormat: castHlsVideoSegmentFormat || "(not set)",
          loadMediaResult: result.loaded ? "resolved" : result.outcome,
          outcome: result.outcome,
          detail: result.detail,
          waitedMs: result.waitedMs ?? null,
          deadlineMs: result.deadlineMs ?? CAST_PLAYBACK_DEADLINE_MS,
          receiverState: result.lastState || null,
          receiverTime: result.lastTime ?? null,
          idleReason: lastReceiverIdleReason,
          castErrorCode: result.code ?? null,
          receiverMediaError: lastReceiverMediaError,
          fallbackAttempted: index > 0
        });
        if (result.outcome === "playing") {
          castLoadResult = "playing";
          castPlaybackConfirmed = true;
          syncCastStopControl();
          castLog("playing on the receiver", { candidate: candidate.label, waitedMs: result.waitedMs });
          if (art) art.notice.show = "Casting";
          try { art?.video?.pause?.(); } catch (error) { /* already stopped */ }
          return;
        }
        if (result.outcome === "superseded") return;
        castLoadResult = result.outcome;
        castLoadError = result.detail;
        console.error("[Cast] attempt did not reach playback", JSON.stringify({
          candidate: candidate.label,
          host: hostOnly(candidate.url),
          contentType: candidate.contentType,
          codec: result.detection?.codec || "not-detected",
          container: result.detection?.packaging || "not-detected",
          outcome: result.outcome,
          detail: result.detail,
          receiverState: result.lastState || null,
          idleReason: lastReceiverIdleReason,
          remaining: ladder.length - index - 1
        }));
        // Drop the dead media before the next rung so the receiver is not left
        // holding a stream it could not play.
        await abortCastAttempt();
        if (token !== castAttemptSeq) return;
        if (index < ladder.length - 1 && art) {
          art.notice.show = "That source did not start - trying another";
        }
      }
      // Every rung failed. Say so plainly rather than leaving the TV spinning.
      if (art) {
        art.notice.show = ladder.length > 1
          ? "None of this episode\u2019s sources would play on your TV."
          : "Your TV could not play this source, and this episode has no other.";
      }
      console.error("[Cast] every candidate failed", JSON.stringify({ attempts: castAttempts }));
    } finally {
      castLadderRunning = false;
    }
  }

  // Inspectable from DevTools. Deliberately carries no URLs, tokens or headers.
  // NOTE: this is the PLAYER FRAME's window. In the app the player runs inside
  // #animePlayerFrame, and DevTools evaluates against the top frame by default, so
  // reading window.__ZENKAI_CAST_DEBUG__ there finds nothing. client.js installs a
  // bridge on the top window that delegates here.
  window.__ZENKAI_CAST_DEBUG__ = {
    frame: "player",
    get sdkAvailable() { return Boolean(window.chrome?.cast); },
    get frameworkAvailable() { return Boolean(window.cast?.framework); },
    get initState() { return castInitState; },
    get receiverApplicationId() { return castReceiverAppId; },
    get castState() { return castStateNow(); },
    get sessionState() { return sessionStateNow(); },
    // Runs the same detection loadCastMedia uses, without needing a receiver.
    async detectCodec() {
      const url = castMediaUrl();
      const contentType = castContentType();
      const result = await detectCastVideoCodec(url, contentType);
      const SegFmt = window.chrome?.cast?.media?.HlsSegmentFormat;
      const VidFmt = window.chrome?.cast?.media?.HlsVideoSegmentFormat;
      const isFmp4 = result.packaging === "FMP4";
      const isMpegTs = result.packaging === "MPEG2_TS";
      const segmentFormat = isFmp4 ? SegFmt?.FMP4 : (isMpegTs ? SegFmt?.TS : null);
      const videoSegmentFormat = isFmp4 ? VidFmt?.FMP4 : (isMpegTs ? VidFmt?.MPEG2_TS : null);
      return {
        detectedVideoCodec: result.codec,
        codecDetectionMethod: result.method,
        hlsPackaging: result.packaging,
        hlsPackagingEvidence: result.packagingHow,
        wouldSetHlsSegmentFormat: segmentFormat ? String(segmentFormat) : "(not set)",
        wouldSetHlsVideoSegmentFormat: videoSegmentFormat ? String(videoSegmentFormat) : "(not set)",
        sourceHost: castSourceLabel(),
        urlClassification: classifyCastUrl(url, contentType)
      };
    },
    snapshot() {
      const ctx = castContext();
      return {
        sdkLoaded: Boolean(window.chrome?.cast),
        frameworkNamespace: Boolean(window.cast?.framework),
        contextInitialized: Boolean(ctx),
        initState: castInitState,
        receiverApplicationId: castReceiverAppId,
        castState: castStateNow(),
        sessionState: sessionStateNow(),
        hasCurrentSession: Boolean(castSession()),
        hasMediaSession: Boolean(castMedia()),
        loadMediaCalled: castLoadCalled,
        lastMediaLoadResult: castLoadResult,
        lastMediaLoadError: castLoadError,
        // One row per candidate tried, with what the RECEIVER did about it. This
        // is the thing to copy out of a real-device test.
        attempts: castAttempts,
        activeEpisode: episode || "(none)",
        activeSourceName: castSourceLabel(),
        // Both are derived from the one sourceUrl this player was opened with, so
        // they are equal by construction - which is the guarantee, not a coincidence.
        castSourceName: castSourceLabel(),
        sameSourceForCast: true,
        detectedVideoCodec: castDetectedCodec || "not-detected",
        codecDetectionMethod: castCodecMethod || "not-run",
        codecDetectionResult: castCodecResult,
        castBlockedForCodec,
        mediaUrlType: castLastUrlType || classifyCastUrl(castMediaUrl(), castContentType()),
        contentType: castLastContentType || castContentType(),
        hlsPackaging: castHlsPackaging || "not-detected",
        hlsSegmentFormat: castHlsSegmentFormat || "(not set)",
        hlsVideoSegmentFormat: castHlsVideoSegmentFormat || "(not set)",
        remoteIsConnected: remotePlayer ? remotePlayer.isConnected : null,
        remoteIsMediaLoaded: remotePlayer ? remotePlayer.isMediaLoaded : null,
        remotePlayerState: remotePlayer ? remotePlayer.playerState : null,
        remoteCurrentTime: remotePlayer ? remotePlayer.currentTime : null,
        remoteDuration: remotePlayer ? remotePlayer.duration : null,
        lastReceiverIdleReason,
        lastReceiverMediaError,
        mediaSessionSeenAt,
        secureContext: window.isSecureContext,
        host: window.location.hostname
      };
    }
  };

  // ── Chromecast ───────────────────────────────────────────────────────────
    // Registered only where it can actually work. The Google Cast sender SDK is
    // Chromium-only and needs a secure context, so on Firefox/Safari or over plain
    // http the button would be permanently dead - better not to draw it at all.
    // NOTE: localhost IS a secure context, so development is not excluded here.
    //
    // No `url` is passed on purpose: the plugin falls back to art.option.url, which
    // ArtPlayer keeps current across switchUrl(), so casting follows the episode,
    // server and quality the viewer is actually on rather than whatever happened to
    // load first.
    const castSupported = window.isSecureContext
      && Boolean(window.chrome)
      && !/\b(?:Firefox|OPR)\//i.test(navigator.userAgent);
    if (castSupported) {
      // Replaces the plugin entirely. The control name is kept so the existing
      // .art-control-chromecast styling still applies unchanged.
      playerOptions.controls = playerOptions.controls || [];
      playerOptions.controls.push({
        name: "chromecast",
        position: "right",
        index: 14,
        html: '<i class="art-icon art-icon-cast"><svg height="20" width="20" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 576 512"><path d="M512 96H64v99c-13-2-26.4-3-40-3H0V96C0 60.7 28.7 32 64 32H512c35.3 0 64 28.7 64 64V416c0 35.3-28.7 64-64 64H288V456c0-13.6-1-27-3-40H512V96zM24 224c128.1 0 232 103.9 232 232c0 13.3-10.7 24-24 24s-24-10.7-24-24c0-101.6-82.4-184-184-184c-13.3 0-24-10.7-24-24s10.7-24 24-24zm8 192a32 32 0 1 1 0 64 32 32 0 1 1 0-64zM0 344c0-13.3 10.7-24 24-24c75.1 0 136 60.9 136 136c0 13.3-10.7 24-24 24s-24-10.7-24-24c0-48.6-39.4-88-88-88c-13.3 0-24-10.7-24-24z"/></svg></i>',
        tooltip: "Cast to a device",
        click: (_component, event) => {
          event.stopPropagation();
          // Straight off the user gesture: the Cast chooser is gated on user
          // activation, and awaiting anything first can spend it.
          startCastSession();
        }
      });
      playerOptions.controls.push({
        name: "chromecast-stop",
        position: "right",
        index: 13,
        html: '<button class="ztv-cast-stop-button" type="button" aria-label="Stop casting"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2"/></svg></button>',
        tooltip: "Stop casting",
        mounted: (control) => control.setAttribute("aria-hidden", "true"),
        click: (_component, event) => {
          event.stopPropagation();
          stopConfirmedCast();
        }
      });
    }

    art = new window.Artplayer(playerOptions);
    wireArtEvents();
    wireVolumePanelLinger();
    attachChromeToPlayer();
    followControlVisibility();
    wireTapToHideControls();
    watchPictureInsets();
    syncNextEpisodeControl();
    mountSkipLayer();
    // Up front, not on click: the SDK has to be loaded and the context configured
    // before anything can know whether a receiver exists.
    initCastFramework();
    console.log("[Cast] debug helper installed", window.location.href);
    startMascot();
  }

  // ── Watching on a phone ─────────────────────────────────────────────────
  // Browsing stays portrait; watching goes landscape. Tapping the picture on a
  // phone takes the video fullscreen, and going fullscreen locks the screen
  // sideways, so the picture fills the display without the viewer having to
  // rotate the device - and without the site itself ever being forced sideways.
  //
  // Once already fullscreen the tap goes back to its other job: dismissing the
  // control layer at once instead of waiting out CONTROL_HIDE_TIME. The volume
  // rail lives inside that layer, so this is what makes it go away on demand.
  function isPhonePlayer() {
    // Artplayer's own device detection, set once at construction - it survives
    // rotation, where a width media query would not.
    return Boolean(art?.template?.$player?.classList.contains("art-mobile"));
  }

  // screen.orientation.lock() only works while something is actually fullscreen,
  // and iOS Safari has no implementation at all - it either rejects or is
  // missing. Artplayer's autoOrientation covers that case by rotating its own
  // container instead, so a failure here is not worth reporting.
  function lockLandscape() {
    const orientation = window.screen && window.screen.orientation;
    if (!orientation || typeof orientation.lock !== "function") return;
    try {
      const locking = orientation.lock("landscape");
      if (locking && typeof locking.catch === "function") locking.catch(() => {});
    } catch (error) { /* unsupported on this browser */ }
  }

  function unlockOrientation() {
    const orientation = window.screen && window.screen.orientation;
    if (!orientation || typeof orientation.unlock !== "function") return;
    try { orientation.unlock(); } catch (error) { /* unsupported on this browser */ }
  }

  // The topbar and the two corner buttons are siblings of the player in the page.
  // Artplayer requests fullscreen on its own $player element, and a fullscreen
  // element renders only its own subtree - so in fullscreen the whole chrome
  // disappeared. Moving it inside $player keeps it on screen there. The picture
  // inset vars it anchors to are set on documentElement, so nothing about the
  // positioning changes.
  function attachChromeToPlayer() {
    const player = art?.template?.$player;
    if (!player) return;
    ["#playerTopbar", "#backButton", "#chromeToggle", "#floatingLabel"].forEach((selector) => {
      const node = document.querySelector(selector);
      if (node && node.parentElement !== player) player.appendChild(node);
    });
  }

  // Follow the control bar exactly, so the chrome fades with the progress bar on
  // pointer idle and comes back on the next move. Artplayer owns that timing;
  // mirroring its event means the two can never drift apart.
  function followControlVisibility() {
    if (!art) return;
    const apply = (visible) => {
      document.body.classList.toggle("ztv-controls-hidden", !visible);
    };
    apply(Boolean(art.controls && art.controls.show));
    art.on("control", apply);
  }

  function wireTapToHideControls() {
    const player = art?.template?.$player;
    if (!player) return;

    // The document's own event, not Artplayer's: this fires however fullscreen
    // was entered - our tap, the fullscreen button, or the system back gesture
    // leaving it - so the lock and the release can never drift apart.
    const onFullscreenChange = () => {
      if (!isPhonePlayer()) return;
      if (document.fullscreenElement || document.webkitFullscreenElement) lockLandscape();
      else unlockOrientation();
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    document.addEventListener("webkitfullscreenchange", onFullscreenChange);

    const isPortrait = () => {
      try { return window.matchMedia("(orientation: portrait)").matches; }
      catch (error) { return window.innerHeight >= window.innerWidth; }
    };
    const enterPortraitFullscreen = () => {
      if (!isPhonePlayer() || !isPortrait()) return false;
      if (document.fullscreenElement || document.webkitFullscreenElement) return false;
      const request = player.requestFullscreen || player.webkitRequestFullscreen;
      if (request) {
        try {
          const pending = request.call(player);
          if (pending?.catch) {
            pending.catch(() => {
              try { art.fullscreen = true; } catch (error) { /* browser declined fullscreen */ }
            });
          }
          return true;
        } catch (requestError) { /* Artplayer remains the compatibility fallback. */ }
      }
      try {
        art.fullscreen = true;
        return true;
      } catch (error) {
        return false;
      }
    };

    // A play button press carries the browser gesture needed by the Fullscreen
    // API. Autoplay may not, so the picture-click path below is the dependable
    // fallback on browsers that reject this first request.
    art.on("play", () => {
      if (!navigator.userActivation || navigator.userActivation.isActive) enterPortraitFullscreen();
    });

    // A phone can be rotated upright after playback has already begun. Fullscreen
    // is still attempted here for installed apps/WebViews that permit it; normal
    // browsers may require the next picture tap, which uses the trusted path below.
    let orientationFullscreenTimer = 0;
    const onPlaybackOrientationChange = () => {
      window.clearTimeout(orientationFullscreenTimer);
      orientationFullscreenTimer = window.setTimeout(() => {
        if (art?.video && !art.video.paused && isPortrait()) enterPortraitFullscreen();
      }, 120);
    };
    window.addEventListener("orientationchange", onPlaybackOrientationChange);
    if (window.screen?.orientation?.addEventListener) {
      window.screen.orientation.addEventListener("change", onPlaybackOrientationChange);
    }

    // Captured on pointerdown because Artplayer's own click handler runs first
    // and may have already re-shown the bar by the time the click listener fires.
    // Without this, a tap meant to REVEAL the controls would hide them again.
    let wasVisible = false;
    player.addEventListener("pointerdown", () => {
      wasVisible = Boolean(art && art.controls && art.controls.show);
    }, true);

    player.addEventListener("click", (event) => {
      const target = event.target;
      // A tap on the bar, the settings popover or the options sheet is the user
      // *using* the controls - only taps on the picture itself count here.
      if (target && target.closest && target.closest(".art-bottom, .art-settings, .art-contextmenus, .art-layers, .ztv-sheet")) return;

      // Only an already-playing portrait video promotes itself. A paused video
      // keeps the normal reveal/play interaction, and every actual control is
      // excluded above, so scrubbing and menu taps never trigger fullscreen.
      if (art?.video && !art.video.paused && enterPortraitFullscreen()) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (!wasVisible) return;
      // Deferred: Artplayer shows the controls from its own click handler, so
      // hiding synchronously here would just be undone.
      window.setTimeout(() => {
        try { art.controls.show = false; } catch (error) { /* player torn down */ }
      }, 0);
    }, true);
  }

  // Long enough to move the pointer from the button onto the panel, short enough
  // that the panel is gone the moment you are done with it. The volume rail used
  // to sit for 4.2s, which read as the panel being stuck.
  const PANEL_LINGER_MS = 1000;

  // Both the volume rail and the settings popover behave the same way: stay open
  // while the pointer is on the button or the panel, close shortly after it
  // leaves either.
  // openOnHover distinguishes the two: the volume rail is a hover affordance and
  // should appear when the pointer reaches it, while the settings popover only
  // ever opens from a deliberate click. Hovering settings must not open it - it
  // may only hold open something the click already opened.
  function wirePanelLinger({ parts, open, close, openOnHover = true }) {
    const nodes = parts.filter(Boolean);
    if (!nodes.length) return;
    let timer = 0;
    let inside = 0;
    const cancelClose = () => { window.clearTimeout(timer); timer = 0; };
    const enter = () => { cancelClose(); if (openOnHover) open(); };
    const closeLater = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => { timer = 0; if (!inside) close(); }, PANEL_LINGER_MS);
    };
    nodes.forEach((node) => {
      node.addEventListener("pointerenter", () => { inside += 1; enter(); });
      node.addEventListener("pointerdown", cancelClose);
      node.addEventListener("focusin", () => { inside += 1; enter(); });
      node.addEventListener("pointerleave", () => { inside = Math.max(0, inside - 1); closeLater(); });
      node.addEventListener("focusout", () => { inside = Math.max(0, inside - 1); closeLater(); });
    });
  }

  function wireVolumePanelLinger() {
    const control = elements.player.querySelector(".art-control-volume");
    if (control) {
      wirePanelLinger({
        parts: [control],
        open: () => control.classList.add("is-volume-open"),
        close: () => control.classList.remove("is-volume-open")
      });
    }

    // Settings opens on click only - Artplayer's own handler does that. All this
    // adds is the closing half: it holds open while the pointer is on the button
    // or the panel, and closes shortly after it leaves both.
    // The popover is a sibling of its button rather than a child, so the pointer
    // leaves the button on the way to the panel; both have to count as "inside"
    // or it would shut in transit.
    const settingButton = elements.player.querySelector(".art-control-setting");
    const settingPanel = elements.player.querySelector(".art-settings");
    if (settingButton && settingPanel && art?.setting) {
      wirePanelLinger({
        parts: [settingButton, settingPanel],
        openOnHover: false,
        open: () => {},
        close: () => { try { art.setting.show = false; } catch (error) {} }
      });
    }
  }

  // ── Phone options sheet ─────────────────────────────────────────────────
  // A bottom sheet behind the "..." control, holding the secondary controls that
  // the <=760px rules take off the bar. Two levels: a root list showing each
  // setting and its current value, and a detail list of choices for one setting.
  //
  // Every entry is derived from what this stream and this browser actually
  // support - renditions come from the parsed HLS manifest, PiP from feature
  // detection. A capability that is absent produces no row rather than a dead one.
  //
  // No subtitle entry on purpose: nothing in the app ever populates the player's
  // `tracks` parameter, so the menu could only ever have rendered "Off". The
  // player still displays a subtitle when one is passed (adult sources force
  // Spanish); there is just no picker for something with nothing to pick.

  const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
  const ASPECTS = [
    { id: "default", label: "Default" },
    { id: "4:3", label: "4:3" },
    { id: "16:9", label: "16:9" }
  ];

  function pipSupported() {
    const video = art?.video;
    return Boolean(
      video &&
      document.pictureInPictureEnabled &&
      !video.disablePictureInPicture &&
      typeof video.requestPictureInPicture === "function"
    );
  }

  // webFullscreenIsDistinct() lived here. Web fullscreen is disabled outright now,
  // so nothing consults it. Worth knowing if it is ever reinstated: it existed for
  // iOS Safari, which cannot fullscreen a container and falls back to the native
  // video shell - that is the one platform where "fill screen" did something real
  // fullscreen could not.

  function levelLabel(level) {
    if (level && Number(level.height) > 0) return `${level.height}p`;
    if (level && Number(level.bitrate) > 0) return `${Math.round(level.bitrate / 1000)} kbps`;
    return "Unknown";
  }

  function qualityOptions() {
    if (hlsLevels.length < 2) return [];
    const ordered = hlsLevels
      .slice()
      .sort((a, b) => (Number(b.height) || 0) - (Number(a.height) || 0));
    return [{ id: -1, label: "Auto", detail: autoQualityDetail() }].concat(
      ordered.map((level) => ({ id: level.index, label: levelLabel(level) }))
    );
  }

  function autoQualityDetail() {
    if (!hls || !hls.autoLevelEnabled) return "";
    const active = hlsLevels.find((level) => level.index === hls.currentLevel);
    return active ? levelLabel(active) : "";
  }

  function currentQualityId() {
    if (!hls) return -1;
    // manualLevel is the rendition the user pinned and updates synchronously.
    // currentLevel is whatever is playing right now and lags a switch by a
    // segment or two - reading it made the row still say "1080p" immediately
    // after picking 720p. -1 means nothing is pinned, i.e. Auto.
    const manual = Number(hls.manualLevel);
    return Number.isFinite(manual) && manual >= 0 ? manual : -1;
  }

  async function togglePip() {
    const video = art?.video;
    if (!video || !pipSupported()) return;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await video.requestPictureInPicture();
    } catch (error) {
      // Denied by policy or interrupted by a source switch. Nothing is broken,
      // and a console error here would fire on every unsupported browser.
    }
  }

  function sheetMenus() {
    const menus = [];

    if (hlsLevels.length > 1) {
      menus.push({
        id: "quality",
        label: "Quality",
        options: qualityOptions(),
        current: () => currentQualityId(),
        apply: (id) => { if (hls) hls.currentLevel = Number(id); }
      });
    } else if (hlsLevels.length === 1 && Number(hlsLevels[0].height) > 0) {
      // One rendition: state it, don't build a selector with a single choice.
      menus.push({ id: "quality", label: "Quality", info: levelLabel(hlsLevels[0]) });
    }

    menus.push({
      id: "speed",
      label: "Playback speed",
      options: SPEEDS.map((rate) => ({ id: String(rate), label: rate === 1 ? "Normal (1x)" : `${rate}x` })),
      current: () => String(art?.playbackRate ?? 1),
      apply: (id) => { if (art) art.playbackRate = Number(id); }
    });

    menus.push({
      id: "aspect",
      label: "Aspect ratio",
      options: ASPECTS,
      current: () => String(art?.aspectRatio || "default"),
      apply: (id) => { if (art) art.aspectRatio = id; }
    });

    if (pipSupported()) {
      menus.push({
        id: "pip",
        label: "Picture-in-picture",
        action: () => { togglePip(); closeOptionsSheet(); }
      });
    }

    // "Fill screen" (web fullscreen) is gone - see fullscreenWeb in playerOptions.

    return menus;
  }

  function ensureOptionsSheet() {
    if (sheet && sheet.root.isConnected) return sheet;
    const host = art?.template?.$player;
    if (!host) return null;

    const root = document.createElement("div");
    root.className = "ztv-sheet";
    root.hidden = true;
    root.innerHTML = [
      '<div class="ztv-sheet-scrim" data-sheet-close></div>',
      '<div class="ztv-sheet-panel" role="dialog" aria-modal="true" aria-label="Player options" tabindex="-1">',
      '  <div class="ztv-sheet-grip" aria-hidden="true"></div>',
      '  <div class="ztv-sheet-head">',
      '    <button class="ztv-sheet-back" type="button" hidden aria-label="Back to options">',
      '      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m14 6-6 6 6 6"></path></svg>',
      '    </button>',
      '    <h2 class="ztv-sheet-title"></h2>',
      '    <button class="ztv-sheet-close" type="button" aria-label="Close options">',
      '      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"></path></svg>',
      '    </button>',
      '  </div>',
      '  <div class="ztv-sheet-body"></div>',
      '</div>'
    ].join("");

    // Contained: a tap inside the sheet must never reach the tap-to-hide handler
    // or Artplayer's play/pause toggle on the picture behind it.
    root.addEventListener("click", (event) => {
      event.stopPropagation();
      if (event.target.closest("[data-sheet-close]")) closeOptionsSheet();
    });

    sheet = {
      root,
      panel: root.querySelector(".ztv-sheet-panel"),
      back: root.querySelector(".ztv-sheet-back"),
      title: root.querySelector(".ztv-sheet-title"),
      body: root.querySelector(".ztv-sheet-body"),
      view: "root"
    };
    sheet.back.addEventListener("click", renderSheetRoot);
    root.querySelector(".ztv-sheet-close").addEventListener("click", () => closeOptionsSheet());
    host.appendChild(root);
    return sheet;
  }

  function sheetRow({ label, value, chevron, checked, onClick, disabled }) {
    const row = document.createElement(onClick ? "button" : "div");
    row.className = "ztv-sheet-row" + (checked ? " is-checked" : "") + (disabled ? " is-static" : "");
    if (onClick) {
      row.type = "button";
      row.addEventListener("click", onClick);
      if (checked !== undefined) row.setAttribute("aria-checked", String(Boolean(checked)));
    }
    const text = document.createElement("span");
    text.className = "ztv-sheet-row-label";
    text.textContent = label;
    row.appendChild(text);
    if (value) {
      const meta = document.createElement("span");
      meta.className = "ztv-sheet-row-value";
      meta.textContent = value;
      row.appendChild(meta);
    }
    if (checked) {
      const tick = document.createElement("span");
      tick.className = "ztv-sheet-tick";
      tick.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 13 4 4 10-10"></path></svg>';
      row.appendChild(tick);
    } else if (chevron) {
      const arrow = document.createElement("span");
      arrow.className = "ztv-sheet-chevron";
      arrow.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m10 6 6 6-6 6"></path></svg>';
      row.appendChild(arrow);
    }
    return row;
  }

  function renderSheetRoot() {
    if (!sheet) return;
    sheet.view = "root";
    sheet.back.hidden = true;
    sheet.title.textContent = "Options";
    sheet.body.replaceChildren();
    sheet.body.setAttribute("role", "list");

    sheetMenus().forEach((menu) => {
      if (menu.options) {
        const current = menu.options.find((option) => String(option.id) === String(menu.current()));
        sheet.body.appendChild(sheetRow({
          label: menu.label,
          value: current ? current.label : "",
          chevron: true,
          onClick: () => renderSheetDetail(menu.id)
        }));
        return;
      }
      if (menu.action) {
        const info = typeof menu.info === "function" ? menu.info() : menu.info;
        sheet.body.appendChild(sheetRow({ label: menu.label, value: info || "", onClick: menu.action }));
        return;
      }
      sheet.body.appendChild(sheetRow({ label: menu.label, value: menu.info, disabled: true }));
    });
  }

  function renderSheetDetail(menuId) {
    if (!sheet) return;
    const menu = sheetMenus().find((entry) => entry.id === menuId);
    if (!menu || !menu.options) { renderSheetRoot(); return; }
    sheet.view = menuId;
    sheet.back.hidden = false;
    sheet.title.textContent = menu.label;
    sheet.body.replaceChildren();

    const selected = String(menu.current());
    menu.options.forEach((option) => {
      const isCurrent = String(option.id) === selected;
      sheet.body.appendChild(sheetRow({
        label: option.detail ? `${option.label} (${option.detail})` : option.label,
        checked: isCurrent,
        onClick: () => {
          menu.apply(option.id);
          renderSheetRoot();
        }
      }));
    });
    sheet.body.querySelector(".ztv-sheet-row")?.focus();
  }

  function openOptionsSheet() {
    const instance = ensureOptionsSheet();
    if (!instance) return;
    renderSheetRoot();
    instance.root.hidden = false;
    moreControl()?.setAttribute("aria-expanded", "true");
    // The bar would otherwise sit on top of the sheet's first rows; the sheet is
    // the control surface while it is open. Playback is untouched.
    try { art.controls.show = false; } catch (error) {}
    instance.panel.focus();
  }

  function moreControl() {
    return art?.template?.$player?.querySelector(".art-control-ztv-more") || null;
  }

  function closeOptionsSheet(options = {}) {
    if (!sheet || sheet.root.hidden) return;
    sheet.root.hidden = true;
    moreControl()?.setAttribute("aria-expanded", "false");
    if (options.silent) return;
    try { art.controls.show = true; } catch (error) {}
    // The bar has to be back on screen before the trigger can take focus.
    moreControl()?.focus();
  }

  function toggleOptionsSheet() {
    if (sheet && !sheet.root.hidden) closeOptionsSheet();
    else openOptionsSheet();
  }

  function optionsSheetOpen() {
    return Boolean(sheet && !sheet.root.hidden);
  }

  // Renditions arrive after the sheet may already be on screen (MANIFEST_PARSED
  // fires late on a slow manifest), so re-render rather than showing a stale list.
  function refreshOptionsSheet() {
    if (!optionsSheetOpen()) return;
    if (sheet.view === "root") renderSheetRoot();
    else renderSheetDetail(sheet.view);
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
  // Three poses, cycled in place - no walking, so she stays put beside the logo.
  // The other sprites (running/jumping/waiting/failed) are still in mascot/ and
  // can be added back here; only these three are shown.
  const MASCOT_SCRIPT = [
    { pose: "review", ms: 9000 },   // standing, reading
    { pose: "idle",   ms: 9000 },   // sitting, head down over the book
    { pose: "waving", ms: 6000 }    // hand raised - blowing a kiss
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

    // Preload a pose so the swap never flashes an empty box; null if absent.
    const resolvePose = (pose) => new Promise((done) => {
      const url = mascotFile(pose);
      const probe = new Image();
      probe.onload = () => done(url);
      probe.onerror = () => done(null);
      probe.src = url;
    });

    const step = async () => {
      for (let tries = 0; tries < MASCOT_SCRIPT.length; tries++) {
        index = (index + 1) % MASCOT_SCRIPT.length;
        const beat = MASCOT_SCRIPT[index];
        if (missing.has(beat.pose)) continue;
        const url = await resolvePose(beat.pose);
        if (!url) { missing.add(beat.pose); continue; }
        resolvedAny = true;

        // Cross-fade in place - the sprite never moves from its spot.
        img.style.opacity = "0";
        window.setTimeout(() => {
          img.src = url;
          img.style.opacity = "1";
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
    art.on("video:seeked", () => {
      syncSkipSegments(video.currentTime || 0);
    });
    art.on("video:loadedmetadata", () => {
      // duration is known now, so segments past the end can be dropped.
      validateSegmentsAgainstDuration(video.duration);
      syncSkipSegments(video.currentTime || 0);
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
      captureArtworkFrame(video);
      syncSkipSegments(position);
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

    startPlayback(video);
  }

  // Autoplay policy is why playback used to sit there until you clicked it.
  // Chrome gates AUDIBLE autoplay behind its Media Engagement Index, Firefox
  // blocks it outright by default, and Safari wants prior engagement - so
  // play() rejects with NotAllowedError on a first visit. The old handlers just
  // called hideLoading(), which removed the spinner and left a decoded, silent
  // first frame on screen with nothing to say it was stuck. Muted playback is
  // permitted everywhere, so retry muted and hand the sound back on the first
  // real interaction. The native-video path in client.js already does this.
  let unmuteArmed = false;

  function armUnmuteOnGesture(video) {
    if (unmuteArmed) return;
    unmuteArmed = true;
    const unmute = () => {
      document.removeEventListener("pointerdown", unmute);
      document.removeEventListener("keydown", unmute);
      unmuteArmed = false;
      if (!video.muted) return;
      video.muted = false;
      if (art?.notice) art.notice.show = "";
      // A pointerdown on the video is also the ArtPlayer play/pause toggle, so it
      // would pause the very video the viewer just asked to hear. We have a user
      // gesture now, so resume on the next tick and let the click mean what it
      // plainly meant: start this properly, with sound.
      setTimeout(() => { if (video.paused) video.play?.().catch(() => {}); }, 0);
      send("volume", getStatus());
    };
    document.addEventListener("pointerdown", unmute, { once: true });
    document.addEventListener("keydown", unmute, { once: true });
  }

  function startPlayback(video) {
    const attempt = video?.play?.();
    if (!attempt || typeof attempt.catch !== "function") return;
    attempt.catch((error) => {
      // Only autoplay blocking is worth retrying. An AbortError means a seek or a
      // source swap interrupted us and something else has already taken over.
      if (error?.name !== "NotAllowedError" || video.muted) {
        hideLoading();
        send("pause", getStatus());
        return;
      }
      video.muted = true;
      const retry = video.play?.();
      if (!retry || typeof retry.then !== "function") return;
      retry.then(() => {
        if (art?.notice) art.notice.show = "Muted to start - tap or press a key for sound";
        armUnmuteOnGesture(video);
        send("volume", getStatus());
      }).catch(() => {
        video.muted = false;
        hideLoading();
        send("pause", getStatus());
      });
    });
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
      hlsLevels = levels;
      refreshOptionsSheet();
      send("qualities", levels);
      reportResolution();
      // Keeps the "Auto (1080p)" hint honest while ABR moves between renditions.
      // Only re-renders when the sheet is actually open.
      hls.on(window.Hls.Events.LEVEL_SWITCHED, refreshOptionsSheet);
      armStartupWatchdog();
      startPlayback(video);
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
    if (command === "segments") {
      applySegments(value);
      return;
    }
    // The parent answering castCandidateLadder()'s request. Nothing else in the
    // player reads it, and a reply that never arrives just leaves the ladder with
    // the one source this frame was opened with.
    if (command === "castCandidates") {
      if (typeof castCandidatesResolve === "function") castCandidatesResolve(Array.isArray(value) ? value : []);
      return;
    }
    if (!art?.video) return;
    const video = art.video;
    if (command === "play") startPlayback(video);
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
    if (event.defaultPrevented || isEditableTarget(event.target)) return;
    // Escape backs out one level at a time: a choice list returns to the root
    // list, the root list closes the sheet. Only then does Escape fall through
    // to whatever the page would normally do with it.
    if (event.key === "Escape" && optionsSheetOpen()) {
      event.preventDefault();
      event.stopPropagation();
      if (sheet.view === "root") closeOptionsSheet();
      else renderSheetRoot();
      return;
    }
    if (!art?.video) return;
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
    // Measured from whichever end is authoritative, so +/-10 stays +/-10 on the TV.
    const nextTime = Math.max(0, Math.min(duration, currentPlaybackTime() + delta));
    if (isCasting()) {
      castSeek(nextTime);
      showSeekToast(delta);
      return;
    }
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

  function captureArtworkFrame(video) {
    if (artworkFrameCaptured || !isEmbeddedPlayer || !video || Number(video.currentTime || 0) < 8) return;
    if (!video.videoWidth || !video.videoHeight) return;
    try {
      const canvas = document.createElement("canvas");
      canvas.width = 480;
      canvas.height = 270;
      const context = canvas.getContext("2d");
      if (!context) return;
      const sourceRatio = video.videoWidth / video.videoHeight;
      const targetRatio = canvas.width / canvas.height;
      let sx = 0;
      let sy = 0;
      let sw = video.videoWidth;
      let sh = video.videoHeight;
      if (sourceRatio > targetRatio) {
        sw = video.videoHeight * targetRatio;
        sx = (video.videoWidth - sw) / 2;
      } else if (sourceRatio < targetRatio) {
        sh = video.videoWidth / targetRatio;
        sy = (video.videoHeight - sh) / 2;
      }
      context.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.7);
      if (!dataUrl.startsWith("data:image/jpeg;base64,") || dataUrl.length > 220000) return;
      artworkFrameCaptured = true;
      send("artworkFrame", { dataUrl, width: canvas.width, height: canvas.height });
    } catch {
      // A cross-origin stream may play normally while intentionally blocking canvas reads.
    }
  }

  // ── Skip segments ───────────────────────────────────────────────────────
  // One generic mechanism, not two parallel ones: every entry in SEGMENT_DEFS
  // gets the same validation, the same visibility rule and the same button.

  function parseSegmentPair(raw) {
    if (raw == null) return null;
    let start;
    let end;
    if (typeof raw === "object") {
      start = Number(raw.start);
      end = Number(raw.end);
    } else {
      const parts = String(raw).split(",");
      if (parts.length !== 2) return null;
      start = Number(parts[0]);
      end = Number(parts[1]);
    }
    // Bad metadata is ignored, never thrown - a broken timestamp must not cost
    // the viewer the episode.
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    if (start < 0 || end <= start) return null;
    return { start, end };
  }

  function parseSegmentsFromParams(search) {
    const out = {};
    for (const def of SEGMENT_DEFS) {
      const seg = parseSegmentPair(search.get(def.key));
      if (seg) out[def.key] = seg;
    }
    return out;
  }

  function validateSegmentsAgainstDuration(duration) {
    const dur = Number(duration);
    if (!Number.isFinite(dur) || dur <= 0) return;
    for (const def of SEGMENT_DEFS) {
      const seg = segments[def.key];
      if (!seg) continue;
      // A segment that starts past the end of the video is meaningless. One that
      // merely runs long is clamped, so a slightly generous outro still works.
      if (seg.start >= dur) { delete segments[def.key]; continue; }
      if (seg.end > dur) seg.end = dur;
      if (seg.end <= seg.start) delete segments[def.key];
    }
  }

  // Replaces every segment at once. Called on a source switch or an episode
  // change, so anything left over from the previous episode is cleared even when
  // the new payload is empty or malformed.
  function applySegments(payload) {
    const next = payload && typeof payload === "object" ? payload : {};
    const key = String(next.episodeKey ?? segmentsEpisodeKey);
    // A response for an episode the viewer has already left must not apply. The
    // parent stamps the key it asked for; if it disagrees with ours, drop it.
    if (next.episodeKey != null && key !== segmentsEpisodeKey) return;
    segments = {};
    for (const def of SEGMENT_DEFS) {
      const seg = parseSegmentPair(next[def.key]);
      if (seg) segments[def.key] = seg;
    }
    validateSegmentsAgainstDuration(art?.video?.duration);
    // undefined, not null: null is a REAL state (no active segment), so resetting
    // to it makes the next sync compare null === null and early-return, leaving a
    // button on screen that belongs to segments we just threw away. undefined can
    // never equal a computed key, so the next sync always repaints.
    activeSegmentKey = undefined;
    syncSkipSegments(art?.video?.currentTime || 0);
  }

  function mountSkipLayer() {
    const root = art?.template?.$player;
    if (!root || skipLayer) return;
    skipLayer = document.createElement("div");
    skipLayer.className = "ztv-skip-layer";
    skipButton = document.createElement("button");
    skipButton.type = "button";
    skipButton.className = "ztv-skip-btn focusable";
    skipButton.addEventListener("click", onSkipClick);
    skipLayer.appendChild(skipButton);
    // Inside the player element, so it comes along into fullscreen for free.
    root.appendChild(skipLayer);
    syncSkipSegments(art?.video?.currentTime || 0);
  }

  function segmentAt(position) {
    for (const def of SEGMENT_DEFS) {
      const seg = segments[def.key];
      if (!seg) continue;
      // Half-open on purpose: at exactly seg.end the segment is over, which is
      // also what makes the button disappear the moment we seek there.
      if (position >= seg.start && position < seg.end) return { key: def.key, label: def.label, seg };
    }
    return null;
  }

  // Cheap enough to run on every timeupdate: a couple of numeric comparisons, and
  // it only touches the DOM when the active segment actually changes.
  function syncSkipSegments(position) {
    if (!skipLayer) return;
    const hit = segmentAt(Number(position) || 0);
    const key = hit ? hit.key : null;
    if (key === activeSegmentKey) return;
    activeSegmentKey = key;
    if (!hit) {
      skipLayer.classList.remove("is-visible");
      skipButton.removeAttribute("data-segment");
      return;
    }
    skipButton.textContent = hit.label;
    skipButton.setAttribute("aria-label", hit.label);
    skipButton.dataset.segment = hit.key;
    skipLayer.classList.add("is-visible");
  }

  function onSkipClick(event) {
    event.preventDefault();
    event.stopPropagation();
    const hit = segmentAt(art?.video?.currentTime || 0);
    if (!hit || !art?.video) return;
    // Routed, not direct: while casting this has to move the RECEIVER, otherwise
    // the TV keeps playing the opening while the local element jumps ahead.
    // A hair past the boundary, clamped to the duration: seeking to exactly end can
    // land at 590.7499 for a 590.75 boundary, which is still inside the segment, so
    // the button flickers straight back. 50ms is imperceptible and lands us out.
    const duration = Number(art?.video?.duration);
    const past = hit.seg.end + 0.05;
    seekTo(Number.isFinite(duration) && duration > 0 ? Math.min(past, duration) : past);
    // Hide immediately rather than waiting for the next timeupdate.
    activeSegmentKey = null;
    skipLayer.classList.remove("is-visible");
    if (art.video.paused) art.video.play?.().catch(() => {});
  }

  // ── Chromecast ──────────────────────────────────────────────────────────
  // A receiver is a separate device on the network: it fetches the media itself,
  // so it needs an absolute URL, an honest content type, and a start position.
  // The plugin supplied none of the three.

  // art.option.url is the RELATIVE proxy path ("/api/source?url=..."). A receiver
  // has no base to resolve that against, so the load could never even be tried.
  function castMediaUrl() {
    try {
      return new URL(sourceUrl, window.location.origin).href;
    } catch (error) {
      return "";
    }
  }

  // Set by the Cast ladder (which lives inside initPlayer) and read by
  // onParentCommand (which does not), so it has to be declared out here where both
  // can see it. Declared inside initPlayer it was invisible to the message handler,
  // and because the handler tests it with typeof - which does not throw for an
  // undeclared name - the parent's reply would have been dropped in silence and the
  // ladder would have quietly had nothing but its own source, for ever.
  let castCandidatesResolve = null;

  // Content type for an ARBITRARY url, so every rung of the Cast ladder is
  // described from its own address rather than from the one source this frame
  // happens to have been opened with.
  //
  // Lives out here, next to castContentType(), and NOT with the rest of the Cast
  // code: that whole block is nested inside initPlayer(), so it can reach outwards
  // to this, while castContentType() - which is out here - could never have
  // reached inwards to it. Getting that backwards made every snapshot() throw.
  function castContentTypeFor(url, typeHint) {
    if (streamType(url, typeHint) === "m3u8") return "application/x-mpegurl";
    let probe = String(url || "");
    try {
      const inner = new URL(url, window.location.origin).searchParams.get("url");
      if (inner) probe = inner;
    } catch (error) { /* not a parseable proxy url - fall through */ }
    const clean = probe.split("?")[0].split("#")[0].toLowerCase();
    if (clean.endsWith(".m3u8")) return "application/x-mpegurl";
    if (clean.endsWith(".mpd")) return "application/dash+xml";
    if (clean.endsWith(".webm")) return "video/webm";
    if (clean.endsWith(".mkv")) return "video/x-matroska";
    if (clean.endsWith(".mov")) return "video/quicktime";
    return "video/mp4";
  }

  // The plugin guesses the type from the last dot-separated token of the URL. For
  // "/api/source?url=...&refererHost=player.zilla-networks.com" that token is
  // "com", so every stream was announced as application/octet-stream and the
  // Default Media Receiver refused it. Resolve from the type hint first, then from
  // the UPSTREAM url inside the proxy query - the proxy path has no extension.
  function castContentType() {
    return castContentTypeFor(sourceUrl, params.get("type"));
  }

  function castSession() {
    try {
      return window.cast?.framework?.CastContext?.getInstance?.()?.getCurrentSession?.() || null;
    } catch (error) {
      return null;
    }
  }

  function castMedia() {
    try { return castSession()?.getMediaSession?.() || null; } catch (error) { return null; }
  }

  function isCasting() {
    return Boolean(castMedia());
  }

  function castSeek(seconds) {
    const media = castMedia();
    if (!media || !window.chrome?.cast?.media?.SeekRequest) return false;
    try {
      const request = new window.chrome.cast.media.SeekRequest();
      request.currentTime = Math.max(0, Number(seconds) || 0);
      media.seek(request, () => {}, (error) => {
        console.warn("[ZenkaiPlayer] Cast seek failed", error);
      });
      return true;
    } catch (error) {
      console.warn("[ZenkaiPlayer] Cast seek threw", error);
      return false;
    }
  }

  // Whichever end is actually playing is the one that knows the time.
  function currentPlaybackTime() {
    const media = castMedia();
    if (media && typeof media.getEstimatedTime === "function") {
      const remote = Number(media.getEstimatedTime());
      if (Number.isFinite(remote)) return remote;
    }
    return Number(art?.video?.currentTime || 0);
  }

  // One seek for the whole player. Rewind/forward, Skip Opening and Skip Ending
  // all go through here, so none of them can move the local video while the TV
  // carries on at the old position.
  function seekTo(seconds) {
    const target = Math.max(0, Number(seconds) || 0);
    if (castSeek(target)) return "remote";
    if (art?.video) art.video.currentTime = target;
    return "local";
  }

  function send(command, value) {
    // Outbound status and inbound commands share one { vcmd } envelope, and
    // onParentCommand listens on this window. When the player is opened as a
    // TOP-LEVEL page rather than in an iframe (openPlayer uses location.assign),
    // window.parent IS window - so every status message we sent came straight
    // back to us as a command. "play" echoed into a play/pause feedback loop
    // that ran thousands of times a second. Only ever talk to a real parent.
    if (!window.parent || window.parent === window) return;
    try {
      window.parent.postMessage(JSON.stringify({ vcmd: command, val: value }), "*");
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
    // Artplayer renders controls as <div>, so each custom one needs the button
    // role, a tab stop and Enter/Space by hand. "ztv-more" belongs here too, or
    // it is unreachable by keyboard and closeOptionsSheet cannot return focus.
    ["rewind-10", "forward-10", "next-episode", "ztv-more"].forEach((name) => {
      const control = elements.player.querySelector(`.art-control-${name}`);
      if (!control || control.dataset.keyboardReady === "1") return;
      control.dataset.keyboardReady = "1";
      control.setAttribute("role", "button");
      control.setAttribute("tabindex", "0");
      if (name === "ztv-more") {
        control.setAttribute("aria-haspopup", "dialog");
        control.setAttribute("aria-expanded", "false");
        control.setAttribute("aria-label", "More options");
      }
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
    // The sheet lives inside Artplayer's own container, so art.destroy() takes
    // the DOM with it. Drop our handle and the stream-specific menu data too, or
    // a retry would rebuild the menu from the previous stream's renditions.
    closeOptionsSheet({ silent: true });
    sheet = null;
    hlsLevels = [];
    // Never leave the device pinned sideways because a source switch tore the
    // player down while it was fullscreen.
    unlockOrientation();
    destroyHls();
    if (!art) return;
    try { art.destroy(false); } catch (error) {}
    art = null;
  }

  function cssUrl(value) {
    return String(value).replace(/["\\\n\r]/g, "");
  }
})();
