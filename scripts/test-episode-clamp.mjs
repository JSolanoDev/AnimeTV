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

// Episode identity now lives in js/normalize.js, and mergeAiredEpisodeMetadata
// calls into it. These are classic scripts sharing one global scope at runtime,
// so the extract has to pull from both files or the function is not defined.
const normalizeSrc = fs.readFileSync(ROOT + "/js/normalize.js", "utf8");
const sliceFrom = (source, start, end) => {
  const a = source.indexOf(start);
  if (a < 0) { console.error("MISS " + start); process.exit(1); }
  const b = source.indexOf(end, a);
  return source.slice(a, b < 0 ? undefined : b);
};

const code = [
  sliceFrom(normalizeSrc, "function canonicalSeasonNumber(", "\nfunction getOriginalProviderEpisodeId("),
  sliceFrom(normalizeSrc, "function getOriginalProviderEpisodeId(", "\nfunction canonicalEpisodeIdentity("),
  slice("function getSeasonEpisodeLimit(", "\nfunction "),
  slice("function clampSeasonEpisodes(", "\nfunction "),
  slice("function mergeAiredEpisodeMetadata(", "\n// Strip a leading"),
  slice("function repairEpisodeGaps(", "\nfunction ")
].join("\n");

const ctx = vm.createContext({
  Number, Math, Array, Date, String, JSON, console, Boolean, Object, Map, Set,
  // mergeAiredEpisodeMetadata's only outside dependency
  extractSeasonNumber: () => 1,
  // repairEpisodeGaps' dependencies
  getEpisodeUrl: (e) => e.videoUrl || e.url || "",
  normalizeEpisodeSourceOptions: () => []
});
vm.runInContext(code, ctx, { filename: "client.js extract" });
const getSeasonEpisodeLimit = vm.runInContext("getSeasonEpisodeLimit", ctx);
const clampSeasonEpisodes = vm.runInContext("clampSeasonEpisodes", ctx);
const mergeAiredEpisodeMetadata = vm.runInContext("mergeAiredEpisodeMetadata", ctx);
const repairEpisodeGaps = vm.runInContext("repairEpisodeGaps", ctx);

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
  // 24 slots: 11 aired (dated in the past), 13 dated in the future. The app marks
  // episodes the source cannot serve as locked - verified in production, where
  // "Smoking Behind the Supermarket" carries locked:true on all 12 of its rows
  // while Mebius Dust carries locked:false on the five it actually serves - so
  // the fixture models that rather than leaving the flag off.
  const show = { title: "Airing", status: "RELEASING", episode: 24,
    episodes: eps(24).map(e => (e.episode > 11 ? { ...e, locked: true } : e)) };
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

/* -- an unlocked episode is never clamped away -------------------------------
   Verified in production: Mebius Dust serves episodes 4..8 with locked:false and
   real videoUrl/streamResolver/server fields, while reporting latestAiredEp 2.
   The clamp deleted all five and repairEpisodeGaps backfilled two empty rows. */
{
  const show = { title: "Mebius Dust", status: "RELEASING", latestAiredEp: 2,
    episodes: [4, 5, 6, 7, 8].map((n) => ({ episode: n })) };
  check("limit still reflects the (wrong) metadata", getSeasonEpisodeLimit(show, {}), 2);
  check("every unlocked episode survives it", clampSeasonEpisodes(show.episodes, show, {}).length, 5);
  check("their numbers are intact", clampSeasonEpisodes(show.episodes, show, {}).map((e) => e.episode), [4, 5, 6, 7, 8]);
}

/* -- locked episodes above the limit are still held back -------------------- */
{
  const show = { title: "Mixed", status: "RELEASING", latestAiredEp: 3 };
  const list = [{ episode: 1 }, { episode: 2 }, { episode: 3 },
                { episode: 4, locked: true }, { episode: 5, locked: true }];
  check("aired kept, locked future ones dropped",
    clampSeasonEpisodes(list, show, {}).map((e) => e.episode), [1, 2, 3]);
}

/* -- the list is repaired up to the episode count the show is KNOWN to have --
   Mushoku Tensei S3: the source returned a single episode while the metadata
   said eleven had aired, so the page rendered exactly one row. */
{
  const one = [{ episode: 1, title: "E1" }];
  check("without a floor only the present episode survives", repairEpisodeGaps(one, 1).length, 1);
  const filled = repairEpisodeGaps(one, 1, 11);
  check("with a floor of 11 the season is 11 long", filled.length, 11);
  check("the real episode is kept", filled[0].title, "E1");
  check("the filled ones are marked unavailable", filled[5].missing, true);
  check("and are locked, so nothing pretends to play", filled[5].locked, true);
  check("a floor below what is present never truncates", repairEpisodeGaps([{ episode: 9 }], 1, 3).length, 9);
  check("a zero floor behaves exactly as before", repairEpisodeGaps(one, 1, 0).length, 1);
  check("a corrupt floor cannot allocate without bound", repairEpisodeGaps(one, 1, 1e9).length, 2000);
  check("an empty list with a floor still fills", repairEpisodeGaps([], 1, 12).length, 12);
}


/* -- a PARTIAL metadata feed is a lower bound, never a ceiling ---------------
   Measured on production 2026-09-06: /api/jikan/episodes?id=59193 (Mushoku
   Tensei S3) answers with exactly ONE row - episode 1, aired 2026-07-04, a real
   PAST date - while the show is known to have 14 episodes and the AnimeAV1
   source serves episode 11 (HTTP 200). undated was therefore 0, the guard
   passed, latestAiredEp became 1, and a 14-episode season rendered as one row. */
{
  const show = { title: "Mushoku Tensei III", status: "RELEASING", totalEpisodes: 14, anilistEpisodeCount: 14, episodes: [] };
  mergeAiredEpisodeMetadata(show, [{ episode: 1, aired: PAST }]);
  check("a one-row feed for a 14-episode show publishes no ceiling", show.latestAiredEp, undefined);
  check("and does not move show.episode either", show.episode, undefined);
  check("so the limit stays unknown rather than 1", getSeasonEpisodeLimit(show, {}), null);
}
{
  // The very same feed once it is COMPLETE: 14 rows, 11 past, 3 future.
  const show = { title: "Mushoku Tensei III", status: "RELEASING", totalEpisodes: 14, anilistEpisodeCount: 14, episodes: [] };
  mergeAiredEpisodeMetadata(show, eps(14).map((e) => ({ episode: e.episode, aired: e.episode <= 11 ? PAST : FUTURE })));
  check("a complete feed IS still trusted", show.latestAiredEp, 11);
  check("and clamps to the last aired episode", getSeasonEpisodeLimit(show, {}), 11);
}
{
  // Short feeds are not an airing-only hazard.
  const show = { title: "Finished", status: "FINISHED", totalEpisodes: 24, episodes: [] };
  mergeAiredEpisodeMetadata(show, [{ episode: 1, aired: PAST }, { episode: 2, aired: PAST }]);
  check("a 2-row feed for a 24-episode show publishes no ceiling", show.latestAiredEp, undefined);
  check("the planned total still answers the limit", getSeasonEpisodeLimit(show, {}), 24);
}
{
  // Regression guard: with no known total there is nothing to compare against,
  // so a fully dated feed must keep behaving exactly as it did before.
  const show = { title: "No total", status: "RELEASING", episode: 3, episodes: eps(12) };
  mergeAiredEpisodeMetadata(show, eps(12).map((e) => ({ episode: e.episode, aired: e.episode <= 9 ? PAST : FUTURE })));
  check("an unknown total still trusts a fully dated feed", show.latestAiredEp, 9);
}


/* -- what the SOURCE serves beats what metadata planned ----------------------
   Measured on production 2026-09-07 by binary-searching AnimeAV1, which answers
   200 for an episode it serves and 404 for one it does not:

     Mushoku Tensei III   app showed 14   source served 11
     Hanaori-san          app showed 12   source served  9
     Mebius Dust          app showed 12   source served  9
     Thunder 3            app showed 12   source served  9
     Smoking Behind...    app showed 12   source served 12   (correct)
     Frieren 2nd Season   app showed 10   source served 10   (correct)

   Every currently-airing show carried exactly three rows that cannot play,
   because a metadata provider only knows the PLANNED total. */
{
  const show = { title: "Mushoku Tensei III", status: "RELEASING", totalEpisodes: 14, anilistEpisodeCount: 14, sourceEpisodeCount: 11 };
  check("the source outranks every metadata guess", getSeasonEpisodeLimit(show, {}), 11);
}
{
  // ...including a latestAiredEp that disagrees.
  const show = { title: "Disagreeing", status: "RELEASING", totalEpisodes: 12, latestAiredEp: 4, sourceEpisodeCount: 9 };
  check("and outranks a stale latestAiredEp", getSeasonEpisodeLimit(show, {}), 9);
}
{
  // A season-level count wins over the show-level one.
  const show = { title: "Show", status: "RELEASING", sourceEpisodeCount: 9 };
  check("a season's own count is preferred", getSeasonEpisodeLimit(show, { sourceEpisodeCount: 12 }), 12);
}
{
  // Never applies to a movie, which is capped before anything else is read.
  const show = { title: "Film", format: "MOVIE", status: "RELEASING", sourceEpisodeCount: 7 };
  check("a movie is still one", getSeasonEpisodeLimit(show, {}), 1);
}
{
  // Absent - which is every finished show - behaves exactly as before.
  const show = { title: "Finished", status: "FINISHED", totalEpisodes: 24 };
  check("without a source count nothing changes", getSeasonEpisodeLimit(show, {}), 24);
  const airing = { title: "Airing", status: "RELEASING", latestAiredEp: 11 };
  check("and an airing show still uses its aired count", getSeasonEpisodeLimit(airing, {}), 11);
}
{
  // A source count can never delete an episode we actually hold and can play.
  const show = { title: "Holds more", status: "RELEASING", sourceEpisodeCount: 9 };
  const held = [10, 11, 12].map((n) => ({ episode: n }));
  check("unlocked episodes survive a lower source count", clampSeasonEpisodes(held, show, {}).length, 3);
}

console.log(rows.join("\n"));
const failed = rows.filter((r) => r.startsWith("FAIL")).length;
console.log(failed ? `\n${failed} FAILED` : "\nall episode-clamp checks passed");
process.exit(failed ? 1 : 0);
