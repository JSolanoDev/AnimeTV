// Exercises the REAL functions lifted out of client.js, so the test tracks the
// shipped source rather than a restatement of it.
import fs from "node:fs";
import vm from "node:vm";

const src = fs.readFileSync("client.js", "utf8");
const slice = (startMarker, endMarker) => {
  const s = src.indexOf(startMarker);
  if (s < 0) { console.error("MISS " + startMarker); process.exit(1); }
  const e = src.indexOf(endMarker, s);
  return src.slice(s, e);
};

const code = [
  slice("function isRetiredAdultArtwork(", "\nfunction imageDeliveryUrl"),
  slice("function imageDeliveryUrl(", "\n// One canonical backdrop"),
  slice("function imageDeliverySrcSet(", "\nconst artworkImagePreloads"),
  slice("function artworkIntrinsicPixels(", "\nfunction artworkDimensionsAreUseful"),
  slice("function artworkDimensionsAreUseful(", "\nfunction "),
  slice("function artworkCanUseContainedPoster(", "\nfunction backdropPixelsLookUseful")
].join("\n");

const ctx = vm.createContext({ URL, console, location: { protocol: "https:", origin: "https://zenkaitv.com", href: "https://zenkaitv.com/" } });
vm.runInContext(code, ctx, { filename: "client.js extract" });
const imageDeliveryUrl = vm.runInContext("imageDeliveryUrl", ctx);
const imageDeliverySrcSet = vm.runInContext("imageDeliverySrcSet", ctx);
const artworkIntrinsicPixels = vm.runInContext("artworkIntrinsicPixels", ctx);
const artworkDimensionsAreUseful = vm.runInContext("artworkDimensionsAreUseful", ctx);
const artworkCanUseContainedPoster = vm.runInContext("artworkCanUseContainedPoster", ctx);
const isRetiredAdultArtwork = vm.runInContext("isRetiredAdultArtwork", ctx);

const rows = [];
const check = (name, got, want) => rows.push(
  `${JSON.stringify(got) === JSON.stringify(want) ? "PASS" : "FAIL"}  ${name}` +
  (JSON.stringify(got) === JSON.stringify(want) ? "" : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`)
);
const img = (naturalWidth, naturalHeight, currentSrc, hasSrcset = true) => ({
  naturalWidth, naturalHeight, currentSrc,
  getAttribute: (a) => (a === "srcset" && hasSrcset ? "x" : null)
});

const TMDB = "https://image.tmdb.org/t/p/original/abc.jpg";
const TMDB780 = "https://image.tmdb.org/t/p/w780/abc.jpg";

/* ---- imageDeliveryUrl: TMDB size mapping ---- */
check("<=342 -> w342", imageDeliveryUrl(TMDB, 200, 90), "https://image.tmdb.org/t/p/w342/abc.jpg");
check("342 -> w342", imageDeliveryUrl(TMDB, 342, 90), "https://image.tmdb.org/t/p/w342/abc.jpg");
check("<=500 -> w500", imageDeliveryUrl(TMDB, 360, 88), "https://image.tmdb.org/t/p/w500/abc.jpg");
check("<=780 -> w780", imageDeliveryUrl(TMDB, 640, 90), "https://image.tmdb.org/t/p/w780/abc.jpg");
check("already-sized input normalises", imageDeliveryUrl(TMDB780, 200, 90), "https://image.tmdb.org/t/p/w342/abc.jpg");
check(">780 stays PROXIED (hero)", imageDeliveryUrl(TMDB, 2560, 92).startsWith("/api/image"), true);
check("781 stays proxied", imageDeliveryUrl(TMDB, 781, 90).startsWith("/api/image"), true);

/* ---- regular image CDNs go direct only for normal card/thumbnail sizes ---- */
const ANILIST = "https://s4.anilist.co/file/x.jpg";
const ANIMEAV1 = "https://cdn.animeav1.com/covers/x.jpg";
const MAL = "https://cdn.myanimelist.net/images/anime/x.jpg";
check("AniList card artwork goes direct", imageDeliveryUrl(ANILIST, 360, 88), ANILIST);
check("AnimeAV1 card artwork goes direct", imageDeliveryUrl(ANIMEAV1, 360, 88), ANIMEAV1);
check("MyAnimeList card artwork goes direct", imageDeliveryUrl(MAL, 360, 88), MAL);
check("tiny AniList blur preview stays proxied", imageDeliveryUrl(ANILIST, 160, 50).startsWith("/api/image"), true);
check("AniList hero stays proxied", imageDeliveryUrl(ANILIST, 1920, 92).startsWith("/api/image"), true);
check("direct CDN can retain a proxy fallback", imageDeliveryUrl(ANILIST, 360, 88, 0, "", true).startsWith("/api/image"), true);
check("adult host stays proxied", imageDeliveryUrl("https://static.underhentai.net/x.jpg", 360, 88).startsWith("/api/image"), true);
check("Bangumi adult fallback stays proxied", imageDeliveryUrl("https://lain.bgm.tv/pic/cover/l/x.jpg", 360, 88).startsWith("/api/image"), true);
check("Shikimori adult fallback stays proxied", imageDeliveryUrl("https://shikimori.one/system/animes/original/x.jpg", 360, 88).startsWith("/api/image"), true);
check("unknown host untouched", imageDeliveryUrl("https://example.com/x.jpg", 360, 88), "https://example.com/x.jpg");
const adultCrop = imageDeliveryUrl("https://static.underhentai.net/assets/title.jpg", 400, 90, 600, "cover");
check("adult source fallback requests a portrait crop", adultCrop.includes("w=400") && adultCrop.includes("h=600") && adultCrop.includes("fit=cover"), true);
check("retired VeoHentai artwork is identified", isRetiredAdultArtwork("https://veohentai.com/wp-content/uploads/dead.jpg"), true);
check("working adult artwork is not retired", isRetiredAdultArtwork("https://static.underhentai.net/assets/title.jpg"), false);

/* ---- malformed TMDB paths must NOT be rewritten ---- */
check("TMDB non /t/p/ path stays proxied", imageDeliveryUrl("https://image.tmdb.org/weird/abc.jpg", 360, 88).startsWith("/api/image"), true);

/* ---- srcset: honest descriptors, deduped ---- */
const ss = imageDeliverySrcSet(TMDB, [200, 280, 360, 400, 480], 90);
check("srcset is produced for direct TMDB", ss.length > 0, true);
check("srcset labels w342 as 342w", ss.includes("/t/p/w342/abc.jpg 342w"), true);
check("srcset labels w500 as 500w", ss.includes("/t/p/w500/abc.jpg 500w"), true);
check("srcset deduplicated to 2 candidates", ss.split(",").length, 2);
check("srcset never labels a file by the requested width", /342w|500w/.test(ss) && !/200w|280w|360w|400w|480w/.test(ss), true);
check("direct CDN needs no synthetic srcset", imageDeliverySrcSet(ANILIST, [200, 360, 480], 90), "");
const ssProxy = imageDeliverySrcSet("https://static.underhentai.net/x.jpg", [200, 360, 480], 90);
check("proxy srcset still uses requested widths", ssProxy.includes("200w") && ssProxy.includes("480w"), true);
const ssAdult = imageDeliverySrcSet(
  "https://static.underhentai.net/assets/title.jpg",
  [200, 400],
  90,
  { aspectRatio: 2 / 3, fit: "cover" }
);
check("adult poster srcset keeps a 2:3 crop at every width", ssAdult.includes("h=300") && ssAdult.includes("h=600") && ssAdult.includes("fit=cover"), true);
check("ineligible host yields no srcset", imageDeliverySrcSet("https://example.com/x.jpg", [200, 360], 90), "");

/* ---- artworkIntrinsicPixels ---- */
check("?w= still recovered", artworkIntrinsicPixels(img(172, 258, "/api/image?src=x&w=360&q=88")).width, 360);
check("TMDB path width recovered", artworkIntrinsicPixels(img(172, 258, "https://image.tmdb.org/t/p/w342/a.jpg")).width, 342);
check("w500 path recovered", artworkIntrinsicPixels(img(250, 375, "https://image.tmdb.org/t/p/w500/a.jpg")).width, 500);
check("upward only - never shrinks", artworkIntrinsicPixels(img(780, 1170, "https://image.tmdb.org/t/p/w342/a.jpg")).width, 780);
check("/original/ is NOT a width", artworkIntrinsicPixels(img(172, 258, "https://image.tmdb.org/t/p/original/a.jpg")).width, 172);
check("/t/p/wabc/ uncompensated", artworkIntrinsicPixels(img(172, 258, "https://image.tmdb.org/t/p/wabc/a.jpg")).width, 172);
check("/t/p/bad/ uncompensated", artworkIntrinsicPixels(img(172, 258, "https://image.tmdb.org/t/p/bad/a.jpg")).width, 172);
check("unrelated URL uncompensated", artworkIntrinsicPixels(img(172, 258, "https://example.com/a.jpg")).width, 172);
check("no srcset -> raw naturalWidth", artworkIntrinsicPixels(img(342, 513, "https://image.tmdb.org/t/p/w342/a.jpg", false)).width, 342);

/* ---- the 180px gate, unchanged, on the real mobile numbers ---- */
check("MOBILE direct TMDB poster PASSES the gate",
  artworkDimensionsAreUseful(img(172, 258, "https://image.tmdb.org/t/p/w342/a.jpg"), "poster"), true);
check("mobile proxy poster still passes",
  artworkDimensionsAreUseful(img(172, 258, "/api/image?src=x&w=360&q=88"), "poster"), true);
check("a genuinely tiny poster is STILL rejected",
  artworkDimensionsAreUseful(img(90, 135, "https://example.com/a.jpg"), "poster"), false);
check("malformed TMDB tiny poster still rejected",
  artworkDimensionsAreUseful(img(90, 135, "https://image.tmdb.org/t/p/wabc/a.jpg"), "poster"), false);
check("responsive landscape source art remains a usable contained fallback",
  artworkCanUseContainedPoster(img(179, 119, "/api/image?src=x&w=280&q=90")), true);

console.log(rows.join("\n"));
const failed = rows.filter((r) => r.startsWith("FAIL")).length;
console.log(failed ? `\n${failed} FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
