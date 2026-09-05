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
        0, 0, 0, 16, 97, 118, 48, 49, 0, 0, 0, 0, 0, 0, 0, 0
      ]);
      return { ok: true, status: 200, text: async () => body, arrayBuffer: async () => bytes.buffer };
    },
    // Player-frame globals the cast block reads.
    params: new URLSearchParams("type=hls"),
    sourceUrl: "https://zenkaitv.com/api/source?url=https%3A%2F%2Fplayer.zilla-networks.com%2Fm3u8%2Fabc&refererHost=player.zilla-networks.com",
    title: "Test", episode: "E1", poster: "",
    streamType: () => "m3u8",
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
    async loadMedia() {
      loadCount++;
      const behaviour = receiverBehaviour[loadCount - 1] || receiverBehaviour[receiverBehaviour.length - 1];
      if (behaviour === "reject") throw Object.assign(new Error("load failed"), { code: "load_failed" });
      // Accepted: the receiver starts buffering.
      playerState = "BUFFERING_STATE"; idleReason = null;
      if (behaviour === "play") setTimeout(() => { playerState = "PLAYING_STATE"; media.currentTime = 1; }, 200);
      if (behaviour === "error") setTimeout(() => { playerState = "IDLE_STATE"; idleReason = "ERROR_REASON"; }, 200);
      // "hang" -> stays BUFFERING forever.
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
        HlsSegmentFormat: { FMP4: "fmp4" },
        HlsVideoSegmentFormat: { FMP4: "fmp4" },
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
  ` + castContentTypeForSrc + `
  `, ctx);
  // Shorten the deadline in the SOURCE TEXT rather than reassigning the const, so
  // the production value stays a const and the test still runs the real code path.
  const block = deadlineMs
    ? castBlock.replace(/const CAST_PLAYBACK_DEADLINE_MS = \d+;/, `const CAST_PLAYBACK_DEADLINE_MS = ${deadlineMs};`)
    : castBlock;
  vm.runInContext(block, ctx, { filename: "player.js cast block" });

  return { ctx, notices, stops, loadCount: () => loadCount, timers };
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
  env.timers.forEach(clearTimeout);
}

/* 6. A master playlist declaring CODECS must NOT skip packaging detection -
      that dead branch is what made the v683 fix a no-op on real ladders. */
{
  const MASTER = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS=\"av01.0.05M.08,mp4a.40.2\"\nv1.m3u8\n";
  const env = makeEnv({ receiverBehaviour: ["play"], manifest: MASTER, variantManifest: FMP4_MANIFEST });
  // The variant fetch returns the same manifest text in this harness, so a master
  // that is followed reports the fMP4 evidence from the variant.
  const out = await vm.runInContext("detectCastVideoCodec('https://zenkaitv.com/api/source?url=x')", env.ctx);
  check("6. master playlist codec still read", out.codec, "AV1");
  check("6b. packaging is no longer abandoned as UNKNOWN", out.packaging !== "UNKNOWN", true);
  check("6c. and it says the variant was followed", /^variant:/.test(out.packagingHow), true);
  env.timers.forEach(clearTimeout);
}

/* 7. MPEG-TS must stay undescribed - that path already casts. */
{
  const TS = "#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:4,\nseg1.ts\n#EXT-X-ENDLIST\n";
  const env = makeEnv({ receiverBehaviour: ["play"], manifest: TS });
  await vm.runInContext("loadCastMedia()", env.ctx);
  check("7. MPEG-TS sets no HLS format fields", vm.runInContext("castHlsSegmentFormat", env.ctx), "");
  check("7b. nor the video one", vm.runInContext("castHlsVideoSegmentFormat", env.ctx), "");
  env.timers.forEach(clearTimeout);
}

console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log(failed ? `\n${failed} CHECK(S) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
