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
  const CAST_DEV = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname);
  const CAST_SDK = "https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1";
  let castInitState = "idle";
  let castInitStarted = false;
  let castReceiverAppId = "";

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
    if (castInitStarted) return;
    castInitStarted = true;
    if (!window.isSecureContext || !window.chrome || /\b(?:Firefox|OPR)\//i.test(navigator.userAgent)) {
      castInitState = "unsupported-browser";
      castLog("unsupported browser or insecure context - not loading the SDK");
      return;
    }
    castInitState = "loading-sdk";
    window.__onGCastApiAvailable = (available, reason) => {
      castLog("SDK callback received", { available, reason });
      if (!available) {
        castInitState = "sdk-unavailable";
        console.error("[Cast] SDK reported unavailable", { reason });
        return;
      }
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
        // setOptions exactly once, not per click.
        ctx.setOptions({
          receiverApplicationId: castReceiverAppId,
          autoJoinPolicy: window.chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED
        });
        ctx.addEventListener(window.cast.framework.CastContextEventType.CAST_STATE_CHANGED, (event) => {
          const name = enumName(window.cast.framework.CastState, event.castState);
          castLog("state:", name);
          syncCastControl(name);
        });
        ctx.addEventListener(window.cast.framework.CastContextEventType.SESSION_STATE_CHANGED, (event) => {
          castLog("session:", enumName(window.cast.framework.SessionState, event.sessionState));
        });
        castInitState = "ready";
        castLog("initialization complete", { receiverApplicationId: castReceiverAppId, castState: castStateNow() });
        syncCastControl(castStateNow());
      } catch (error) {
        castInitState = "init-failed";
        console.error("[Cast] initialization failed", error);
      }
    };
    const script = document.createElement("script");
    script.src = CAST_SDK;
    script.async = true;
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
    const before = { castState: castStateNow(), sessionState: sessionStateNow() };
    castLog("requestSession from click", before);
    // Discovery found nothing. That is NOT a session failure, and saying so sends
    // people to debug their Wi-Fi when the SDK simply has no receiver to offer.
    if (before.castState === "NO_DEVICES_AVAILABLE") {
      console.error("[Cast] no devices available", { ...before, receiverApplicationId: castReceiverAppId });
      if (art) art.notice.show = "No Chromecast devices found";
      return;
    }
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
    castLog("session established", { castState: castStateNow(), sessionState: sessionStateNow() });
    loadCastMedia();
  }

  // Stage 3. A failure here is about the MEDIA, never about discovery.
  function loadCastMedia() {
    const session = castSession();
    if (!session) { console.error("[Cast] no session after connect"); return; }
    const url = castMediaUrl();
    if (!url || /^blob:/i.test(url)) {
      console.error("[Cast] refusing to cast a non-fetchable url", { url: url ? url.slice(0, 24) + "..." : "(empty)" });
      if (art) art.notice.show = "This source can't be cast";
      return;
    }
    try {
      const media = new window.chrome.cast.media.MediaInfo(url, castContentType());
      const meta = new window.chrome.cast.media.GenericMediaMetadata();
      meta.title = title || "ZenkaiTV";
      if (episode) meta.subtitle = String(episode);
      if (poster) meta.images = [new window.chrome.cast.Image(poster)];
      media.metadata = meta;
      const request = new window.chrome.cast.media.LoadRequest(media);
      const at = Number(art?.video?.currentTime || 0);
      request.currentTime = Number.isFinite(at) && at > 1 ? at : 0;
      request.autoplay = true;
      castLog("loading media", { contentType: castContentType(), currentTime: request.currentTime });
      session.loadMedia(request).then(() => {
        castLog("media loaded");
        if (art) art.notice.show = "Casting";
        try { art?.video?.pause?.(); } catch (error) { /* already stopped */ }
      }).catch((error) => {
        console.error("[Cast] loadMedia failed", { error, code: String(error?.code ?? error), contentType: castContentType() });
        if (art) art.notice.show = "Connected, but this source couldn't be loaded";
      });
    } catch (error) {
      console.error("[Cast] building the load request threw", error);
      if (art) art.notice.show = "Connected, but this source couldn't be loaded";
    }
  }

  // Inspectable from DevTools. Deliberately carries no URLs, tokens or headers.
  window.__ZENKAI_CAST_DEBUG__ = {
    get sdkAvailable() { return Boolean(window.chrome?.cast); },
    get frameworkAvailable() { return Boolean(window.cast?.framework); },
    get initState() { return castInitState; },
    get receiverApplicationId() { return castReceiverAppId; },
    get castState() { return castStateNow(); },
    get sessionState() { return sessionStateNow(); },
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

      // NOTE: a tap here used to go straight to fullscreen on a phone, to get
      // landscape in one gesture. It made the inline player unusable - every tap
      // meant to reveal the controls, pause, or scrub threw you into fullscreen
      // instead, and there was no way to just *use* the player on the page.
      // Landscape is still one press away on the fullscreen control, which locks
      // the orientation through the fullscreenchange handler above.
      if (!wasVisible) return;
      // Deferred: Artplayer shows the controls from its own click handler, so
      // hiding synchronously here would just be undone.
      window.setTimeout(() => {
        try { art.controls.show = false; } catch (error) { /* player torn down */ }
      }, 0);
    });
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

  // The plugin guesses the type from the last dot-separated token of the URL. For
  // "/api/source?url=...&refererHost=player.zilla-networks.com" that token is
  // "com", so every stream was announced as application/octet-stream and the
  // Default Media Receiver refused it. Resolve from the type hint first, then from
  // the UPSTREAM url inside the proxy query - the proxy path has no extension.
  function castContentType() {
    if (streamType(sourceUrl, params.get("type")) === "m3u8") return "application/x-mpegURL";
    let probe = String(sourceUrl || "");
    try {
      const inner = new URL(sourceUrl, window.location.origin).searchParams.get("url");
      if (inner) probe = inner;
    } catch (error) { /* not a parseable proxy url - fall through */ }
    const clean = probe.split("?")[0].split("#")[0].toLowerCase();
    if (clean.endsWith(".m3u8")) return "application/x-mpegURL";
    if (clean.endsWith(".mpd")) return "application/dash+xml";
    if (clean.endsWith(".webm")) return "video/webm";
    if (clean.endsWith(".mkv")) return "video/x-matroska";
    if (clean.endsWith(".mov")) return "video/quicktime";
    return "video/mp4";
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
