import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync("client.js", "utf8");
const start = source.indexOf("function episodeChunkContextKey(");
const end = source.indexOf("function renderEpisodeList(", start);
if (start < 0 || end <= start) throw new Error("Could not locate episode chunk helpers");

const context = vm.createContext({
  state: {
    activeSeasonIndex: 0,
    activeEpisodeChunkIndex: 0,
    activeEpisode: null,
    episodeChunkByContext: {}
  },
  getShowKey: (show) => show.id
});
vm.runInContext(source.slice(start, end), context, { filename: "client.js episode chunk helpers" });

const metadataStart = source.indexOf("function usesContinuousGlobalEpisodeMetadata(");
const metadataEnd = source.indexOf("function metadataSeasonNumber(", metadataStart);
if (metadataStart < 0 || metadataEnd <= metadataStart) throw new Error("Could not locate episode metadata scope helpers");
context.SeasonNormalization = { parseTitle: () => ({ seasonNumber: 1 }) };
vm.runInContext(source.slice(metadataStart, metadataEnd), context, { filename: "client.js episode metadata scope helpers" });

const naruto = { id: "animeav1-naruto" };
const onePiece = { id: "animeav1-one-piece" };
const season = { season: 1, part: 1 };

context.setEpisodeChunkIndex(naruto, season, 0, 2);
context.setEpisodeChunkIndex(onePiece, season, 0, 8);

const checks = [
  ["Naruto keeps its own 201-300 range", context.getEpisodeChunkIndex(naruto, season, 0, 3, 100), 2],
  ["One Piece keeps its own 801-900 range", context.getEpisodeChunkIndex(onePiece, season, 0, 12, 100), 8],
  ["a shortened inventory clamps the saved range", context.getEpisodeChunkIndex(onePiece, season, 0, 4, 100), 3],
  ["season parts have independent keys", context.episodeChunkContextKey(naruto, { season: 1, part: 2 }, 0), "animeav1-naruto:s1:p2"],
  ["the Naruto route has no Shippuden alias", source.includes('"naruto": ["naruto"]'), true],
  ["literal route slugs are resolved before relation aliases", source.indexOf("state.shows.find(exactSlug)") < source.indexOf("const relationCarrier = state.shows.find"), true],
  ["catalog detail routes do not inherit the newest episode", source.includes("const rawEpisodeTarget = target.episodeNumber;"), true],
  ["continuous Naruto metadata is not mistaken for a separate season", context.requiresSeasonScopedEpisodeMetadata({
    title: "Naruto",
    isFranchiseEntry: true,
    totalEpisodes: 220,
    seasons: [{ season: 1, episodes: Array.from({ length: 220 }) }],
    tmdbSeasons: [
      { season_number: 1, episode_count: 52 },
      { season_number: 2, episode_count: 52 },
      { season_number: 3, episode_count: 54 },
      { season_number: 4, episode_count: 62 }
    ]
  }), false],
  ["short franchise seasons remain isolated", context.requiresSeasonScopedEpisodeMetadata({
    title: "Mushoku Tensei III",
    isFranchiseEntry: true,
    totalEpisodes: 12,
    seasons: [{ season: 3, episodes: Array.from({ length: 12 }) }],
    tmdbSeasons: [{ season_number: 3, episode_count: 12 }]
  }), true]
];

let failed = 0;
for (const [name, actual, expected] of checks) {
  const ok = actual === expected;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` (got ${actual}, expected ${expected})`}`);
}
console.log(failed ? `\n${failed} episode chunk check(s) failed` : "\nall episode chunk checks passed");
process.exit(failed ? 1 : 0);
