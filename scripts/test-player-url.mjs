// Guards the player iframe URL against the 431 that a data: URI poster caused.
// Lifts the real playerPosterParam out of client.js so the test tracks shipped
// source rather than restating it.
import fs from "node:fs";
import vm from "node:vm";

const ROOT = process.argv[2] || ".";
const src = fs.readFileSync(ROOT + "/client.js", "utf8");
const appCss = fs.readFileSync(ROOT + "/styles.css", "utf8");
const playerCss = fs.readFileSync(ROOT + "/player/player.css", "utf8");

const start = src.indexOf("const PLAYER_POSTER_MAX_LENGTH");
if (start < 0) { console.error("MISS PLAYER_POSTER_MAX_LENGTH"); process.exit(1); }
const end = src.indexOf("\nfunction buildPlayerUrl(", start);
const ctx = vm.createContext({});
vm.runInContext(src.slice(start, end), ctx, { filename: "client.js extract" });
const playerPosterParam = vm.runInContext("playerPosterParam", ctx);

const rows = [];
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  rows.push(`${ok ? "PASS" : "FAIL"}  ${name}` + (ok ? "" : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`));
};

const TMDB = "https://image.tmdb.org/t/p/original/abc.jpg";
const HTTPS = "https://cdn.example.com/poster.jpg";
const HTTP = "http://cdn.example.com/poster.jpg";
const DATA = "data:image/jpeg;base64," + "A".repeat(40000);
const DATA_SMALL = "data:image/png;base64,iVBORw0KGgo=";

/* ---- allowed ---- */
check("TMDB https poster passes through", playerPosterParam(TMDB), TMDB);
check("ordinary https poster passes through", playerPosterParam(HTTPS), HTTPS);
check("http poster passes through", playerPosterParam(HTTP), HTTP);
check("surrounding whitespace trimmed", playerPosterParam("  " + HTTPS + "  "), HTTPS);

/* ---- the 431 cause: data URIs are dropped ---- */
check("huge data: URI is dropped", playerPosterParam(DATA), "");
check("even a SMALL data: URI is dropped", playerPosterParam(DATA_SMALL), "");
check("blob: URI is dropped", playerPosterParam("blob:https://x/9f2"), "");

/* ---- bounded ---- */
check("an over-long https URL is dropped", playerPosterParam("https://x/" + "a".repeat(2000)), "");
check("a URL just under the bound survives", playerPosterParam("https://x/" + "a".repeat(1000)).length, 1010);

/* ---- empty / invalid ---- */
for (const [label, value] of [["empty string", ""], ["undefined", undefined], ["null", null], ["a relative path", "/img/a.jpg"], ["a bare filename", "poster.jpg"]]) {
  check(`${label} yields no poster param`, playerPosterParam(value), "");
}

/* ---- the call site actually uses it ---- */
check("buildPlayerUrl routes the poster through the guard",
  /const posterParam = playerPosterParam\(options\.poster\);\s*\r?\n\s*if \(posterParam\) playerUrl\.searchParams\.set\("poster", posterParam\);/.test(src), true);
check("no unguarded poster assignment remains",
  /searchParams\.set\("poster", options\.poster\)/.test(src), false);
check("mobile playback stacks the player before episodes",
  /body\.player-cinema-open \.watch-overlay\.cinematic \.watch-stage\s*\{\s*display:\s*none;/.test(appCss), true);
check("mobile Latest Episodes does not force a blank viewport",
  /#latest\.is-last-band\s*\{\s*min-height:\s*0;\s*justify-content:\s*flex-start;/.test(appCss), true);
check("compact player labels obey both corner insets",
  /\.ztv-floating-label\s*\{[\s\S]*?width:\s*auto;/.test(playerCss), true);
check("narrow controls reserve room for fullscreen",
  /@media \(max-width:\s*560px\)[\s\S]*?\.art-control-rewind-10,[\s\S]*?display:\s*none\s*!important;/.test(playerCss), true);
check("source resolution uses the current player loader without provider copy",
  /class="ztv-stream-loader"[\s\S]*?Loading stream\.\.\.[\s\S]*?:\s*`<div class="play-symbol"/.test(src), true);
check("source resolution loader stays compact and quick",
  /\.ztv-stream-loader-mark\s*>\s*span[\s\S]*?animation:\s*ztv-stream-loader-spin\s+0\.82s/.test(appCss), true);

/* ---- a realistic URL stays well under the header limit ---- */
{
  const url = new URL("https://zenkaitv.com/player/player.html");
  url.searchParams.set("v", "694");
  url.searchParams.set("src", "/api/source?url=https%3A%2F%2Fplayer.example.com%2Fm3u8%2Fabc123");
  url.searchParams.set("title", "It Didn't Have to Be Magic...");
  url.searchParams.set("episode", "Sousou no Frieren — Season 1 Episode 2");
  const poster = playerPosterParam(DATA);
  if (poster) url.searchParams.set("poster", poster);
  check("player URL stays small when the poster is a data URI", url.href.length < 512, true);
}

console.log(rows.join("\n"));
const failed = rows.filter((r) => r.startsWith("FAIL")).length;
console.log(failed ? `\n${failed} FAILED` : "\nall player-url checks passed");
process.exit(failed ? 1 : 0);
