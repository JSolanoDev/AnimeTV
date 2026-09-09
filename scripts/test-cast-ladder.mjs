// Drives the real loadCastMedia() from player/player.js against a fake Cast SDK,
// so the ladder's control flow is exercised rather than argued about.
//
// The player is one big IIFE that needs a DOM, so instead of loading it wholesale
// we lift the Cast block out and run it in a vm with the handful of globals it
// touches. That keeps the test honest about the ACTUAL source text - if the
// control flow in player.js changes, this test sees the change.
import fs from "node:fs";
import vm from "node:vm";

const src = fs.readFileSync("player/player.js", "utf8");

// Extract from the CAST_DEV declaration through the end of loadCastMedia().
const start = src.indexOf("  const CAST_DEV =");
const endMarker = "  // Inspectable from DevTools.";
const end = src.indexOf(endMarker);
if (start < 0 || end < 0) { console.error("could not slice the cast block"); process.exit(1); }
const castBlock = src.slice(start, end);

// castContentTypeFor deliberately lives OUTSIDE initPlayer (castContentType, which
// is also outside, has to be able to call it), so it is not inside the block above.
// Pull the real function in rather than stubbing it - a stub here would have hidden
// the scope bug this test exists to catch.
const helperStart = src.indexOf("  function castContentTypeFor(url, typeHint) {");
if (helperStart < 0) { console.error("could not find castContentTypeFor"); process.exit(1); }
const helperEnd = src.indexOf("\n  }", helperStart);
if (helperEnd < 0) { console.error("could not find the end of castContentTypeFor"); process.exit(1); }
const castContentTypeForSrc = src.slice(helperStart, helperEnd + 4);

const results = [];
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};

function makeEnv({ receiverBehaviour, candidates, manifest, variantManifest, deadlineMs }) {
  const notices = [];
  const stops = [];
  const loads = [];
  let loadCount = 0;
  let playerState = null;
  let idleReason = null;

  const timers = new Set();
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    URL, URLSearchParams, AbortController, Uint8Array, Date, JSON, Math, String, Number, Boolean, Array, Object, Promise, RegExp, Error,
    setTimeout: (...a) => { const t = setTimeout(...a); timers.add(t); return t; },
    clearTimeout: (t) => { clearTimeout(t); timers.delete(t); },
    setInterval: (...a) => { const t = setInterval(...a); timers.add(t); return t; },
    clearInterval: (t) => { clearInterval(t); timers.delete(t); },
    fetch: async (u) => {
      const url = String(u);
      const isVariant = /v1.m3u8/.test(url);
      const body = isVariant ? (variantManifest || manifest) : manifest;
      // styp box at offset 4 = fMP4, then a real av01 fourCC further in so the
      // REAL codecFromFourCC in player.js (which shadows any stub) has something
      // to find. Giving it bytes with no fourCC would test nothing.
      const bytes = new Uint8Array([
        0, 0, 0, 24, 115, 116, 121, 112, 0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 16, 97, 118, 48, 49, 0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 12, 97, 118, 49, 67, 129, 8, 76, 0,
        0, 0, 0, 16, 109, 112, 52, 97, 0, 0, 0, 0, 0, 0, 0, 0
      ]);
      return { ok: true, status: 200, text: async () => body, arrayBuffer: async () => bytes.buffer };
    },
    // Player-frame globals the cast block reads.
    params: new URLSearchParams("type=hls"),
    sourceUrl: "https://zenkaitv.com/api/source?url=https%3A%2F%2Fplayer.zilla-networks.com%2Fm3u8%2Fabc&refererHost=player.zilla-networks.com",
    title: "Test", episode: "E1", poster: "",
    streamType: (url, hint) => {
      const normalizedHint = String(hint || "").toLowerCase();
      if (normalizedHint === "m3u8" || normalizedHint === "hls") return "m3u8";
      return String(url || "").split("?")[0].toLowerCase().endsWith(".m3u8") ? "m3u8" : "";
    },
    segmentsEpisodeKey: "k",
    art: { notice: { set show(v) { notices.push(v); } }, video: { currentTime: 0, pause() {} } },
    localStorage: { getItem: () => null }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.location = { hostname: "zenkaitv.com", origin: "https://zenkaitv.com", search: "" };
  sandbox.window.location = sandbox.location;
  sandbox.window.parent = sandbox.window;   // no parent frame: ladder falls back to own source
  sandbox.navigator = { languages: ["en"], language: "en" };

  const media = {
    get playerState() { return playerState; },
    get idleReason() { return idleReason; },
    currentTime: 0,
    stop(_req, ok) { stops.push(1); playerState = null; idleReason = null; ok && ok(); }
  };
  const session = {
    getMediaSession: () => (playerState === null ? null : media),
    async loadMedia(request) {
      loadCount++;
      loads.push(request);
      const behaviour = receiverBehaviour[loadCount - 1] || receiverBehaviour[receiverBehaviour.length - 1];
      if (behaviour === "reject") throw Object.assign(new Error("load failed"), { code: "load_failed" });
      // Accepted: the receiver starts buffering.
      playerState = "BUFFERING_STATE"; idleReason = null;
      if (behaviour === "play") setTimeout(() => { playerState = "PLAYING_STATE"; media.currentTime = 3.5; }, 200);
      // The exact real-TV failure: metadata disappears and the receiver claims
      // PLAYING, but its clock remains at zero and the panel is black.
      if (behaviour === "falseplay") setTimeout(() => { playerState = "PLAYING_STATE"; }, 200);
      // The receiver decodes a moment of AV1, then its clock freezes while it
      // continues claiming PLAYING. This must not end the fallback ladder.
      if (behaviour === "burst") setTimeout(() => { playerState = "PLAYING_STATE"; media.currentTime = 1; }, 200);
      if (behaviour === "error") setTimeout(() => { playerState = "IDLE_STATE"; idleReason = "ERROR_REASON"; }, 200);
      // A receiver that goes IDLE for a reason OTHER than ERROR. Only counts as a
      // failure once the grace has passed, so this also proves the grace exists.
      if (behaviour === "cancelled") setTimeout(() => { playerState = "IDLE_STATE"; idleReason = "CANCELLED_REASON"; }, 100);
      // Buffering, but the clock is moving: frames ARE being decoded.
      if (behaviour === "creep") setTimeout(() => { media.currentTime = 3.5; }, 300);
      // "hang" -> stays BUFFERING forever, clock frozen at 0.
      return {};
    }
  };

  sandbox.chrome = {
    cast: {
      Image: class { constructor(u) { this.url = u; } },
      media: {
        MediaInfo: class { constructor(id, ct) { this.contentId = id; this.contentType = ct; } },
        LoadRequest: class { constructor(m) { this.media = m; } },
        StopRequest: class {},
        GenericMediaMetadata: class {},
        HlsSegmentFormat: { FMP4: "fmp4", TS: "ts", TS_AAC: "ts_aac" },
        HlsVideoSegmentFormat: { FMP4: "fmp4", MPEG2_TS: "mpeg2_ts" },
        StreamType: { BUFFERED: "BUFFERED" },
        PlayerState: { IDLE: "IDLE_STATE", PLAYING: "PLAYING_STATE", PAUSED: "PAUSED_STATE", BUFFERING: "BUFFERING_STATE" },
        IdleReason: { ERROR: "ERROR_REASON", FINISHED: "FINISHED_REASON", CANCELLED: "CANCELLED_REASON" }
      }
    }
  };
  sandbox.cast = {
    framework: {
      CastContext: { getInstance: () => ({ getCurrentSession: () => session, getCastState: () => "CONNECTED", getSessionState: () => "SESSION_STARTED" }) },
      CastState: { CONNECTED: "CONNECTED" },
      SessionState: { SESSION_STARTED: "SESSION_STARTED" }
    }
  };

  const ctx = vm.createContext(sandbox);
  // The block references a few helpers defined elsewhere in player.js.
  vm.runInContext(`
    function classifyCastUrl(u){ return "HLS"; }
    function castSourceLabel(){ return "player.zilla-networks.com (via /api/source)"; }
    function castUpstreamUrl(){ return ""; }
    function syncCastControl(){}
    function codecFromCodecsAttribute(a){ return /av01/.test(a||"") ? "AV1" : (/avc1/.test(a||"") ? "H.264" : ""); }
    function codecFromFourCC(){ return "AV1"; }
    // These live further down player.js, outside the extracted block.
    function castSession(){ try { return cast.framework.CastContext.getInstance().getCurrentSession(); } catch (e) { return null; } }
    function castMedia(){ try { return castSession().getMediaSession(); } catch (e) { return null; } }
    function castMediaUrl(){ try { return new URL(sourceUrl, location.origin).href; } catch (e) { return ""; } }
    function castContentType(){ return castContentTypeFor(sourceUrl, params.get("type")); }
    // Also outside initPlayer in player.js, so the message handler can reach it.
    let castCandidatesResolve = null;
  ` + castContentTypeForSrc + `
  `, ctx);
  // Stand in for the parent frame. onParentCommand lives outside the extracted
  // block, so replicate exactly what it does: hand the list to castCandidatesResolve.
  if (candidates) {
    sandbox.window.parent = {
      postMessage() {
        setTimeout(() => {
          try {
            vm.runInContext(
              `if (typeof castCandidatesResolve === "function") castCandidatesResolve(${JSON.stringify(candidates)});`,
              ctx
            );
          } catch (error) { /* the ladder falls back to its own source */ }
        }, 10);
      }
    };
  }
  // Shorten the deadline in the SOURCE TEXT rather than reassigning the const, so
  // the production value stays a const and the test still runs the real code path.
  const block = deadlineMs
    ? castBlock.replace(/const CAST_PLAYBACK_DEADLINE_MS = \d+;/, `const CAST_PLAYBACK_DEADLINE_MS = ${deadlineMs};`)
    : castBlock;
  vm.runInContext(block, ctx, { filename: "player.js cast block" });

  return { ctx, notices, stops, loads, loadCount: () => loadCount, timers };
}

const FMP4_MANIFEST = "#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:4,\nseg1.html\n#EXT-X-ENDLIST\n";

/* 1. The receiver plays: one attempt, reported as playing. */
{
  const env = makeEnv({ receiverBehaviour: ["play"], manifest: FMP4_MANIFEST });
  await vm.runInContext("loadCastMedia()", env.ctx);
  check("1. a receiver that plays -> castLoadResult 'playing'", vm.runInContext("castLoadResult", env.ctx), "playing");
  check("1b. exactly one load attempt", env.loadCount(), 1);
  check("1c. notice ends on Casting", env.notices[env.notices.length - 1], "Casting");
  env.timers.forEach(clearTimeout);
}

/* 2. THE BUG: the receiver accepts and then buffers forever. */
{
  const env = makeEnv({ receiverBehaviour: ["hang"], manifest: FMP4_MANIFEST, deadlineMs: 1200 });
  const began = Date.now();
  await vm.runInContext("loadCastMedia()", env.ctx);
  const took = Date.now() - began;
  check("2. a forever-buffering receiver is abandoned, not waited on", vm.runInContext("castLoadResult", env.ctx), "timeout");
  check("2b. it gave up in bounded time ("+took+"ms, deadline 1200)", took < 4000, true);
  check("2c. the dead media was stopped", env.stops.length >= 1, true);
  check("2d. the viewer is told, not left spinning",
    /could not play this source/.test(env.notices[env.notices.length - 1] || ""), true);
  const attempts = vm.runInContext("JSON.parse(JSON.stringify(castAttempts))", env.ctx);
  check("2e. one attempt recorded, with the receiver's last state", attempts.length, 1);
  check("2f. attempt outcome is timeout", attempts[0].outcome, "timeout");
  check("2g. attempt carries the codec it tried", attempts[0].codec, "AV1");
  check("2h. attempt logs host only, no query string", /\?/.test(attempts[0].host), false);
  env.timers.forEach(clearTimeout);
}

/* 3. The receiver reports IDLE/ERROR: abandoned immediately, not after the clock. */
{
  const env = makeEnv({ receiverBehaviour: ["error"], manifest: FMP4_MANIFEST, deadlineMs: 10000 });
  const began = Date.now();
  await vm.runInContext("loadCastMedia()", env.ctx);
  const took = Date.now() - began;
  check("3. IDLE/ERROR is acted on at once", vm.runInContext("castLoadResult", env.ctx), "error");
  check("3b. it did NOT wait out the deadline", took < 3000, true);
  env.timers.forEach(clearTimeout);
}

/* 4. loadMedia itself rejecting is still one attempt, no retry. */
{
  const env = makeEnv({ receiverBehaviour: ["reject"], manifest: FMP4_MANIFEST });
  await vm.runInContext("loadCastMedia()", env.ctx);
  check("4. a rejected load is reported", vm.runInContext("castLoadResult", env.ctx), "rejected");
  check("4b. no retry of the same candidate", env.loadCount(), 1);
  env.timers.forEach(clearTimeout);
}

/* 5. fMP4 packaging really is described to the receiver. */
{
  const env = makeEnv({ receiverBehaviour: ["play"], manifest: FMP4_MANIFEST });
  await vm.runInContext("loadCastMedia()", env.ctx);
  check("5. hlsSegmentFormat set for CMAF", vm.runInContext("castHlsSegmentFormat", env.ctx), "fmp4");
  check("5b. hlsVideoSegmentFormat set for CMAF", vm.runInContext("castHlsVideoSegmentFormat", env.ctx), "fmp4");
  const castUrl = new URL(env.loads[0]?.media?.contentId);
  check("5c. AV1 source keeps the same upstream stream", castUrl.searchParams.get("url"),
    "https://player.zilla-networks.com/m3u8/abc");
  check("5c2. AV1 source declares its exact codec for the Cast-only master", castUrl.searchParams.get("castCodecs"),
    "av01.0.08M.10,mp4a.40.2");
  check("5d. AV1 request declares an HLS content type", env.loads[0]?.media?.contentType, "application/x-mpegurl");
  check("5e. AV1 request declares fMP4 media segments", env.loads[0]?.media?.hlsSegmentFormat, "fmp4");
  check("5f. AV1 request declares fMP4 video segments", env.loads[0]?.media?.hlsVideoSegmentFormat, "fmp4");
  env.timers.forEach(clearTimeout);
}

/* 6. A master playlist declaring CODECS must NOT skip packaging detection -
      that dead branch is what made the v683 fix a no-op on real ladders. */
{
  const MASTER = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS=\"av01.0.05M.08,mp4a.40.2\"\nv1.m3u8\n";
  const env = makeEnv({ receiverBehaviour: ["play"], manifest: MASTER, variantManifest: FMP4_MANIFEST });
  // The variant fetch returns the same manifest text in this harness, so a master
  // that is followed reports the fMP4 evidence from the variant.
  const out = await vm.runInContext("detectCastVideoCodec('https://zenkaitv.com/api/source?url=x', 'application/x-mpegurl')", env.ctx);
  check("6. master playlist codec still read", out.codec, "AV1");
  check("6b. packaging is no longer abandoned as UNKNOWN", out.packaging !== "UNKNOWN", true);
  check("6c. and it says the variant was followed", /^variant:/.test(out.packagingHow), true);
  env.timers.forEach(clearTimeout);
}

/* 7. MPEG-TS must carry the exact HLS format metadata documented by Cast. */
{
  const TS = "#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:4,\nseg1.ts\n#EXT-X-ENDLIST\n";
  const env = makeEnv({ receiverBehaviour: ["play"], manifest: TS });
  await vm.runInContext("loadCastMedia()", env.ctx);
  check("7. MPEG-TS declares TS media segments", vm.runInContext("castHlsSegmentFormat", env.ctx), "ts");
  check("7b. MPEG-TS declares MPEG2_TS video segments", vm.runInContext("castHlsVideoSegmentFormat", env.ctx), "mpeg2_ts");
  env.timers.forEach(clearTimeout);
}

const TWO = [
  { label: "AnimeAV1", url: "/api/source?url=https%3A%2F%2Fplayer.zilla-networks.com%2Fm3u8%2Fabc", type: "hls" },
  { label: "Second Server", url: "/api/source?url=https%3A%2F%2Fplayer.zilla-networks.com%2Fm3u8%2Fdef", type: "hls" }
];

/* 8. A stuck first candidate must hand over to the second. */
{
  const env = makeEnv({ receiverBehaviour: ["hang", "play"], manifest: FMP4_MANIFEST, candidates: TWO, deadlineMs: 900 });
  await vm.runInContext("loadCastMedia()", env.ctx);
  check("8. a stuck candidate falls through to the next", vm.runInContext("castLoadResult", env.ctx), "playing");
  check("8b. exactly two loads - one per candidate", env.loadCount(), 2);
  const attempts = vm.runInContext("JSON.parse(JSON.stringify(castAttempts))", env.ctx);
  check("8c. both attempts recorded", attempts.length, 2);
  check("8d. the first is not marked a fallback", attempts[0].fallbackAttempted, false);
  check("8e. the second is", attempts[1].fallbackAttempted, true);
  check("8f. rung numbering is 1-of-2 then 2-of-2", `${attempts[0].rung}/${attempts[0].of} ${attempts[1].rung}/${attempts[1].of}`, "1/2 2/2");
  env.timers.forEach(clearTimeout);
}

/* 9 + 10. Every candidate is tried at most ONCE, and the ladder terminates. */
{
  const env = makeEnv({ receiverBehaviour: ["hang", "hang"], manifest: FMP4_MANIFEST, candidates: TWO, deadlineMs: 700 });
  const began = Date.now();
  await vm.runInContext("loadCastMedia()", env.ctx);
  const took = Date.now() - began;
  check("9. two candidates -> exactly two attempts, never a retry", env.loadCount(), 2);
  check("10. the ladder terminates instead of looping", took < 6000, true);
  check("10b. and says every source failed",
    /None of this episode/.test(env.notices[env.notices.length - 1] || ""), true);
  env.timers.forEach(clearTimeout);
}

/* 10c. PLAYING at a frozen 0:00 is the black-screen symptom, not success. */
{
  const env = makeEnv({ receiverBehaviour: ["falseplay", "play"], manifest: FMP4_MANIFEST, candidates: TWO, deadlineMs: 900 });
  await vm.runInContext("loadCastMedia()", env.ctx);
  check("10c. false PLAYING at 0:00 falls through", vm.runInContext("castLoadResult", env.ctx), "playing");
  check("10d. the black first media is stopped", env.stops.length >= 1, true);
  const attempts = vm.runInContext("JSON.parse(JSON.stringify(castAttempts))", env.ctx);
  check("10e. frozen PLAYING is recorded as timeout", attempts[0].outcome, "timeout");
  check("10f. frozen receiver time remains zero", attempts[0].receiverTime, 0);
  env.timers.forEach(clearTimeout);
}

/* 11. Buffering with the clock moving is real playback, not the hang. */
{
  const env = makeEnv({ receiverBehaviour: ["creep"], manifest: FMP4_MANIFEST, deadlineMs: 4000 });
  await vm.runInContext("loadCastMedia()", env.ctx);
  check("11. BUFFERING with an advancing clock counts as playing", vm.runInContext("castLoadResult", env.ctx), "playing");
  env.timers.forEach(clearTimeout);
}

/* 11b. One second of playback followed by a freeze is not success. */
{
  const env = makeEnv({ receiverBehaviour: ["burst", "play"], manifest: FMP4_MANIFEST, candidates: TWO, deadlineMs: 1400 });
  await vm.runInContext("loadCastMedia()", env.ctx);
  check("11b. a one-second AV1 burst falls through to H.264", vm.runInContext("castLoadResult", env.ctx), "playing");
  check("11c. the burst source is stopped before fallback", env.stops.length >= 1, true);
  const attempts = vm.runInContext("JSON.parse(JSON.stringify(castAttempts))", env.ctx);
  check("11d. the short burst is not recorded as successful", attempts[0].outcome === "playing", false);
  check("11e. the fallback is the successful attempt", attempts[1].outcome, "playing");
  env.timers.forEach(clearTimeout);
}

/* 12. IDLE for a reason other than ERROR still ends the attempt - after the grace. */
{
  const env = makeEnv({ receiverBehaviour: ["cancelled"], manifest: FMP4_MANIFEST, deadlineMs: 20000 });
  const began = Date.now();
  await vm.runInContext("loadCastMedia()", env.ctx);
  const took = Date.now() - began;
  check("12. IDLE/CANCELLED is treated as failure", vm.runInContext("castLoadResult", env.ctx), "error");
  check(`12b. it waited out the 2s grace, not the 20s deadline (${took}ms)`, took > 1800 && took < 8000, true);
  const attempts = vm.runInContext("JSON.parse(JSON.stringify(castAttempts))", env.ctx);
  check("12c. the idleReason is recorded", /CANCELLED/.test(String(attempts[0].idleReason)), true);
  env.timers.forEach(clearTimeout);
}

/* 13. The attempt row carries what a real-device report needs. */
{
  const env = makeEnv({ receiverBehaviour: ["hang"], manifest: FMP4_MANIFEST, deadlineMs: 700 });
  await vm.runInContext("loadCastMedia()", env.ctx);
  const a = vm.runInContext("JSON.parse(JSON.stringify(castAttempts))", env.ctx)[0];
  check("13. audio codec is reported", a.audioCodec, "AAC");
  check("13b. container evidence is reported", a.containerEvidence, "EXT-X-MAP present");
  check("13c. the deadline is reported alongside the wait", a.deadlineMs, 700);
  check("13d. loadMedia's own result is distinguished from the outcome",
    `${a.loadMediaResult}/${a.outcome}`, "resolved/timeout");
  check("13e. no URL, query string or token in the row",
    /\?|token|refererHost|http/i.test(JSON.stringify(a).replace(/"manifestType":"[^"]*"/, "")), false);
  env.timers.forEach(clearTimeout);
}

/* 14. A rejected load records the Cast error code. */
{
  const env = makeEnv({ receiverBehaviour: ["reject"], manifest: FMP4_MANIFEST });
  await vm.runInContext("loadCastMedia()", env.ctx);
  const a = vm.runInContext("JSON.parse(JSON.stringify(castAttempts))", env.ctx)[0];
  check("14. the Cast error code is captured", a.castErrorCode, "load_failed");
  check("14b. and the outcome is rejected", a.outcome, "rejected");
  env.timers.forEach(clearTimeout);
}

/* 15. The proxy's Content-Type rules, read straight out of animetv-server.js so
      the test cannot drift away from what actually ships. */
{
  const server = fs.readFileSync("animetv-server.js", "utf8");
  const grab = (name) => {
    const m = server.match(new RegExp(`const ${name} = ([^;]+);`));
    return m ? m[1] : null;
  };
  const disguised = grab("isZillaDisguisedSegment");
  const other = grab("isZillaOtherSegment");
  const directMp4 = grab("isDirectMp4");
  const useless = grab("upstreamTypeIsUseless");
  check("15. the narrow disguised-segment rule is the one that ships", Boolean(disguised && /\\.html\$/.test(disguised)), true);
  check("15b. other spellings are a separate, conditional rule", Boolean(other && /m3u8\|html/.test(other)), true);
  check("15c. and it only fires on a useless upstream type", Boolean(useless && /octet-stream/.test(useless)), true);
  check("15c2. direct MP4 correction ships", Boolean(directMp4 && /mp4\|m4v/.test(directMp4)), true);

  // Evaluate the real predicates rather than restating them.
  const H = "0".repeat(32);
  const evalFor = (pathname, upstreamType) => {
    const targetUrl = { pathname };
    const isZilla = true;
    const isZillaDisguisedSegment = eval(disguised);
    const isZillaOtherSegment = eval(other);
    const isDirectMp4 = eval(directMp4);
    const upstreamTypeIsUseless = eval(useless.replace(/upstreamType/g, JSON.stringify(upstreamType)));
    if (isZillaDisguisedSegment) return "video/mp4";
    if (isDirectMp4 && upstreamTypeIsUseless) return "video/mp4";
    if (isZillaOtherSegment && upstreamTypeIsUseless) return "video/mp4";
    return upstreamType || "application/json; charset=utf-8";
  };
  check("15d. disguised .html segment is corrected", evalFor(`/segs/${H}/seg1.html`, "text/html"), "video/mp4");
  check("15e. init.mp4 with a useless type is corrected", evalFor(`/segs/${H}/init.mp4`, "text/html"), "video/mp4");
  check("15f. init.mp4 with a CORRECT type is left alone", evalFor(`/segs/${H}/init.mp4`, "video/mp4"), "video/mp4");
  check("15g. a segment the origin typed as audio is NOT overwritten", evalFor(`/segs/${H}/a.m4s`, "audio/mp4"), "audio/mp4");
  check("15h. a playlist under /segs keeps its own type", evalFor(`/segs/${H}/index.m3u8`, "application/vnd.apple.mpegurl"), "application/vnd.apple.mpegurl");
  check("15i. a subtitle is never rewritten", evalFor(`/segs/${H}/subs.vtt`, "text/vtt"), "text/vtt");
  check("15j. the manifest path itself is untouched", evalFor(`/m3u8/${H}`, "application/vnd.apple.mpegurl"), "application/vnd.apple.mpegurl");
  check("15k. direct MP4 with octet-stream is corrected", evalFor("/video.mp4", "application/octet-stream"), "video/mp4");
  check("15l. direct MP4 with a valid type is untouched", evalFor("/video.mp4", "video/mp4"), "video/mp4");
  check("15m. Cast wrapper only accepts a narrow AV1/AAC CODECS value",
    /function sanitizeCastCodecs[\s\S]*?\^av01/.test(server), true);
  check("15n. Cast wrapper emits a one-variant master",
    /#EXT-X-STREAM-INF:BANDWIDTH=5000000,CODECS/.test(server), true);
  check("15o. VOD manifests warm the receiver through a bounded shared cache",
    /playlistIsVod[\s\S]*?s-maxage=900/.test(server), true);
  check("15p. immutable CMAF fragments are CDN cached",
    /isZillaDisguisedSegment \|\| isZillaOtherSegment \|\| isGuploadSegment[\s\S]*?s-maxage=604800/.test(server), true);

  const embedStart = server.indexOf("function unpackPackedJs(");
  const embedEnd = server.indexOf("function resolvedEmbedPlaybackUrl(", embedStart);
  const embedCtx = vm.createContext({ URL, URLSearchParams });
  vm.runInContext(server.slice(embedStart, embedEnd), embedCtx);
  const streamTapeFixture = [
    '<div>//streamtape.com/get_video id=abc&expires=1&ip=ip1&token=decoy</div>',
    '<script>//streamtape.com/get_vi id=abc&expires=2&ip=ip2&token=working</script>'
  ].join("\n");
  const streamTape = vm.runInContext(`extractStreamFromEmbed(${JSON.stringify(streamTapeFixture)})`, embedCtx);
  check("15q. Streamtape's disguised .mp4 embed resolves to get_video", streamTape?.type, "mp4");
  check("15r. the final scripted Streamtape token wins over decoys",
    new URL(streamTape?.url).searchParams.get("token"), "working");
  check("15s. a Streamtape /e/*.mp4 URL is treated as an embed page",
    /isStreamTapeEmbed[\s\S]*?!isStreamTapeEmbed/.test(server), true);
  check("15t. Cast HEAD probes become bounded one-byte upstream requests",
    /isHeadRequest[\s\S]*?headers\.Range = "bytes=0-0"/.test(server), true);
  check("15u. HEAD probes close without draining the media body",
    /if \(isHeadRequest\)[\s\S]*?upstream\.body\?\.cancel\?\.\(\)[\s\S]*?response\.end\(\)/.test(server), true);
  check("15v. partial media responses advertise byte-range support",
    /upstream\.status === 206[\s\S]*?responseHeaders\["accept-ranges"\] = "bytes"/.test(server), true);
  check("15w. Streamtape MP4 responses advertise seeking even before the first range",
    /isStreamTapeMedia \|\| upstream\.status === 206[\s\S]*?responseHeaders\["accept-ranges"\] = "bytes"/.test(server), true);
  check("15x. packed embed scripts are unpacked from the complete document",
    /const wholePacked = unpackPackedJs\(text\)/.test(server), true);

  const rewriteStart = server.indexOf("function rewriteM3u8Playlist(");
  const rewriteEnd = server.indexOf("async function handleTranslate(", rewriteStart);
  const rewriteCtx = vm.createContext({ URL, URLSearchParams });
  vm.runInContext(server.slice(rewriteStart, rewriteEnd), rewriteCtx);
  const rewritten = vm.runInContext(`rewriteM3u8Playlist(${JSON.stringify([
    "#EXTM3U",
    '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"',
    "#EXTINF:6,",
    "segment-1.ts",
    ""
  ].join("\n"))}, "https://cdn.example/hls/master.m3u8?token=abc", "sfastwish.com")`, rewriteCtx);
  const rewrittenUris = String(rewritten).match(/\/api\/source\?[^"\n]+/g) || [];
  check("15y. generic HLS keys and segments stay on the short-request relay", rewrittenUris.length, 2);
  check("15z. rewritten HLS children preserve the provider Referer",
    rewrittenUris.every((uri) => new URL(uri, "https://zenkaitv.com").searchParams.get("refererHost") === "sfastwish.com"), true);
}

/* 16. Nothing in the sender pretends it can ask the receiver about codecs. */
{
  const player = fs.readFileSync("player/player.js", "utf8");
  check("16. no canDisplayType call in the sender", /canDisplayType\s*\(/.test(player), false);
  check("16b. no CastReceiverContext use in the sender", /CastReceiverContext/.test(player), false);
  check("16c. no transcode path", /transcod/i.test(player), false);
  check("16d. the Cast SDK script has a singleton marker", /data-zenkai-cast-sdk/.test(player), true);
  check("16e. Cast context configuration has a singleton guard", /__ZENKAI_CAST_CONTEXT_CONFIGURED__/.test(player), true);
  check("16f. native AirPlay is limited to Safari", /airplay:\s*\/\\bSafari/.test(player), true);
  check("16g. Cast candidates and codec are warmed while the picker is open",
    /const preparation = Promise\.allSettled[\s\S]*?await ctx\.requestSession\(\)[\s\S]*?await preparation/.test(player), true);
  check("16h. declared HLS type reaches extensionless Cast codec detection",
    /detectCastVideoCodec\(candidate\.url, candidate\.contentType\)/.test(player), true);
  check("16i. the official RemotePlayer integration is activated",
    (player.match(/initRemotePlayer\(\)/g) || []).length >= 3, true);
  check("16j. each accepted load is followed by media-session observation",
    /await session\.loadMedia\(request\);\s*observeMediaSession\(candidate\.label\)/.test(player), true);
  check("16k. an existing CastSession is reused instead of requested again",
    /let session = castSession\(\);[\s\S]*?if \(!session\) \{[\s\S]*?await ctx\.requestSession\(\)/.test(player), true);
  check("16l. duplicate chooser clicks are suppressed",
    /if \(castSessionStarting\)[\s\S]*?castSessionStarting = true/.test(player), true);
  check("16m. playback polling can read the framework RemotePlayer state",
    /media\?\.playerState \|\| remotePlayer\?\.playerState/.test(player), true);
}

/* 17. The parent prepares a segmented, proxied TV fallback only on Cast request. */
{
  const client = fs.readFileSync("client.js", "utf8");
  const backupStart = client.indexOf("const CAST_BACKUP_PREPARE_TIMEOUT_MS");
  const backupEnd = client.indexOf("// The poster travels in the player iframe's QUERY STRING", backupStart);
  if (backupStart < 0 || backupEnd < 0) throw new Error("could not slice Cast backup preparation");
  const calls = [];
  const castBackupSandbox = {
    console: { warn() {} },
    URL,
    encodeURIComponent,
    Number,
    Promise,
    state: {
      activeShow: { title: "Test Show", animeAv1Slug: "test-show" },
      activeEpisode: { episode: { episode: 1, providerEpisodeId: 1 } }
    },
    AdultMode: { isAdultContent: () => false },
    isScraperEnabled: () => true,
    getVerifiedFallbackSourceEpisode: () => null,
    animeAv1CatalogSlugForShow: (show) => show.animeAv1Slug,
    getInventoryProviderEpisodeId: (_show, episode) => episode.providerEpisodeId,
    getCanonicalEpisodeNumber: (episode) => episode.episode,
    fetchWithTimeout: async (endpoint) => {
      calls.push(["lookup", endpoint]);
      return {
        ok: true,
        json: async () => ({
          ok: true,
          episodeUrl: "https://jkanime.net/test-show/1",
          sources: [
            { provider: "Streamtape", url: "https://streamtape.com/e/abc/video.mp4", sourceRank: 4 },
            { provider: "Streamwish", url: "https://sfastwish.com/e/segmented", sourceRank: 1 },
            { provider: "Mp4upload", url: "https://www.mp4upload.com/embed-1.html", sourceRank: 5 }
          ]
        })
      };
    },
    attemptResolveEmbed: async (url, referer, timeout) => {
      calls.push(["resolve", url, referer, timeout]);
      if (url.includes("sfastwish")) {
        return { url: "https://cdn.example/video/master.m3u8?token=abc", type: "hls" };
      }
      return url.includes("streamtape")
        ? { url: "/api/source?url=https%3A%2F%2Fstreamtape.com%2Fget_video%3Fid%3Dabc&refererHost=streamtape.com", type: "mp4" }
        : { url: "https://a3.mp4upload.com:183/d/token/video.mp4", type: "mp4" };
    },
    proxiedStreamUrl: (url, referer) => {
      calls.push(["proxy", url, referer]);
      const proxy = new URL("https://zenkaitv.com/api/source");
      proxy.searchParams.set("url", url);
      proxy.searchParams.set("refererHost", new URL(referer).host);
      return proxy.href;
    },
    streamTypeFromUrl: (url) => /\.m3u8(?:$|\?)/i.test(url) ? "hls" : "",
    buildCastCandidateList: () => [{ label: "AnimeAV1", url: "/api/source?url=av1", type: "hls" }],
    wait: () => new Promise(() => {}),
    location: { origin: "https://zenkaitv.com" }
  };
  castBackupSandbox.window = castBackupSandbox;
  const backupContext = vm.createContext(castBackupSandbox);
  vm.runInContext(client.slice(backupStart, backupEnd), backupContext, { filename: "client.js cast backup block" });
  const prepared = await vm.runInContext("buildPreparedCastCandidateList()", backupContext);
  check("17. Cast preparation appends one fallback", prepared.length, 2);
  check("17b. exact AnimeAV1 slug and episode are requested", calls[0][1], "/api/jkanime/sources?slug=test-show&episode=1");
  check("17c. segmented HLS is resolved before progressive Streamtape", /sfastwish/.test(calls[1][1]), true);
  check("17d. resolved HLS stays on the short-request media relay", new URL(prepared[1].url).pathname, "/api/source");
  check("17e. resolver is tightly bounded", calls[1][3], 3000);
  check("17f. the resolver's HLS type reaches the Cast ladder", prepared[1].type, "hls");
  check("17g. the relay preserves the embed host as Referer", new URL(prepared[1].url).searchParams.get("refererHost"), "sfastwish.com");
  check("17g2. the original HLS URL stays nested in the relay", new URL(prepared[1].url).searchParams.get("url"), "https://cdn.example/video/master.m3u8?token=abc");

  castBackupSandbox.AdultMode.isAdultContent = () => true;
  const adult = await vm.runInContext("buildPreparedCastCandidateList()", backupContext);
  check("17h. regular backup never crosses into adult mode", adult.length, 1);
}

console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log(failed ? `\n${failed} CHECK(S) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
