// A show must never lose playable episodes to a metadata guess.
//
// Mushoku Tensei S3 shipped 14 playable episodes with a parseable air date on
// only the first. mergeAiredEpisodeMetadata treated "no date" and "future date"
// identically, so `latest` came out 1, was written to latestAiredEp, and
// getSeasonEpisodeLimit clamped the list to a single row.
import fs from "node:fs";
import vm from "node:vm";

const ROOT = process.argv[2] || ".";
const src = fs.readFileSync(ROOT + "/client.js", "utf8");

const slice = (start, end) => {
  const a = src.indexOf(start);
  if (a < 0) { console.error("MISS " + start); process.exit(1); }
  const b = src.indexOf(end, a);
  return src.slice(a, b < 0 ? undefined : b);
};

const code = [
  slice("function getSeasonEpisodeLimit(", "\nfunction "),
  slice("function clampSeasonEpisodes(", "\nfunction "),
  slice("function mergeAiredEpisodeMetadata(", "\n// Strip a leading")
].join("\n");

const ctx = vm.createContext({
  Number, Math, Array, Date, String, JSON, console,
  // mergeAiredEpisodeMetadata's only outside dependency
  extractSeasonNumber: () => 1
});
vm.runInContext(code, ctx, { filename: "client.js extract" });
const getSeasonEpisodeLimit = vm.runInContext("getSeasonEpisodeLimit", ctx);
const clampSeasonEpisodes = vm.runInContext("clampSeasonEpisodes", ctx);
const mergeAiredEpisodeMetadata = vm.runInContext("mergeAiredEpisodeMetadata", ctx);

const rows = [];
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  rows.push(`${ok ? "PASS" : "FAIL"}  ${name}` + (ok ? "" : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`));
};

const PAST = "2026-01-05T00:00:00Z";
const FUTURE = new Date(Date.now() + 7 * 864e5).toISOString();
const eps = (n) => Array.from({ length: n }, (_, i) => ({ episode: i + 1, title: `E${i + 1}` }));

/* ── the exact production shape ───────────────────────────────────────────── */
{
  // 14 playable episodes; only episode 1 carries a usable air date.
  const show = { title: "Mushoku Tensei III", status: "RELEASING", episode: 14, totalEpisodes: 14, episodes: eps(14) };
  const metadata = eps(14).map((e, i) => ({ episode: e.episode, aired: i === 0 ? PAST : "" }));
  mergeAiredEpisodeMetadata(show, metadata);
  check("an undated list does NOT publish latestAiredEp", show.latestAiredEp, undefined);
  const limit = getSeasonEpisodeLimit(show, {});
  check("limit falls through to the episode count", limit, 14);
  check("all 14 episodes survive the clamp", clampSeasonEpisodes(show.episodes, show, {}).length, 14);
}

/* ── a genuinely mid-air show still clamps ────────────────────────────────── */
{
  // 24 slots: 11 aired (dated in the past), 13 dated in the future.
  const show = { title: "Airing", status: "RELEASING", episode: 24, episodes: eps(24) };
  const metadata = eps(24).map((e) => ({ episode: e.episode, aired: e.episode <= 11 ? PAST : FUTURE }));
  mergeAiredEpisodeMetadata(show, metadata);
  check("a fully dated list DOES publish latestAiredEp", show.latestAiredEp, 11);
  check("limit is the last aired episode", getSeasonEpisodeLimit(show, {}), 11);
  check("unaired episodes are still hidden", clampSeasonEpisodes(show.episodes, show, {}).length, 11);
}

/* ── one undated entry is enough to distrust the bound ────────────────────── */
{
  const show = { title: "Partly dated", status: "RELEASING", episode: 20, episodes: eps(20) };
  const metadata = eps(20).map((e) => ({ episode: e.episode, aired: e.episode === 7 ? "" : (e.episode <= 11 ? PAST : FUTURE) }));
  mergeAiredEpisodeMetadata(show, metadata);
  check("a single undated entry withholds latestAiredEp", show.latestAiredEp, undefined);
  check("episodes are not deleted by a guess", clampSeasonEpisodes(show.episodes, show, {}).length, 20);
}

/* ── show.episode still advances from real air dates ──────────────────────── */
{
  const show = { title: "Advance", status: "RELEASING", episode: 3, episodes: eps(12) };
  mergeAiredEpisodeMetadata(show, eps(12).map((e) => ({ episode: e.episode, aired: e.episode <= 9 ? PAST : FUTURE })));
  check("show.episode rises to the last aired", show.episode, 9);
  check("show.episode never falls", (() => {
    const s = { title: "NoFall", status: "RELEASING", episode: 30, episodes: eps(30) };
    mergeAiredEpisodeMetadata(s, [{ episode: 2, aired: PAST }]);
    return s.episode;
  })(), 30);
}

/* ── the pre-existing guards must not regress ─────────────────────────────── */
check("a movie is capped at one", getSeasonEpisodeLimit({ format: "MOVIE", status: "RELEASING" }, {}), 1);
check("an unreleased show reports zero", getSeasonEpisodeLimit({ status: "NOT_YET_RELEASED" }, {}), 0);
check("limit 0 keeps unlocked episodes (data beats metadata)",
  clampSeasonEpisodes(eps(5), { status: "NOT_YET_RELEASED" }, {}).length, 5);
check("limit 0 still drops a fully locked list",
  clampSeasonEpisodes(eps(5).map((e) => ({ ...e, locked: true })), { status: "NOT_YET_RELEASED" }, {}).length, 0);
check("an airing show with no signal at all is not clamped",
  getSeasonEpisodeLimit({ status: "RELEASING" }, {}), null);
check("nextAiring still caps a mid-air season",
  getSeasonEpisodeLimit({ status: "RELEASING", nextAiringEpisodeNumber: 12, latestAiredEp: 11 }, {}), 11);

/* ── empty metadata changes nothing ───────────────────────────────────────── */
{
  const show = { title: "Untouched", status: "RELEASING", episode: 8, episodes: eps(8) };
  mergeAiredEpisodeMetadata(show, []);
  check("empty metadata leaves the list alone", show.episodes.length, 8);
  check("empty metadata publishes no latestAiredEp", show.latestAiredEp, undefined);
}

console.log(rows.join("\n"));
const failed = rows.filter((r) => r.startsWith("FAIL")).length;
console.log(failed ? `\n${failed} FAILED` : "\nall episode-clamp checks passed");
process.exit(failed ? 1 : 0);
