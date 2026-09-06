// Regression test for the cached-show crash:
//
//   anime._seasonStillsTried = new Set()   ->  JSON round trip  ->  {}
//   anime._seasonStillsTried.has(sNum)     ->  TypeError, episode panel dies
//
// Loads the REAL js/image-resolver.js in a VM so the assertions track the
// shipped module rather than a restatement of it.
import fs from "node:fs";
import vm from "node:vm";

const ROOT = process.argv[2] || ".";
const src = fs.readFileSync(ROOT + "/js/image-resolver.js", "utf8");

const rows = [];
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  rows.push(`${ok ? "PASS" : "FAIL"}  ${name}` + (ok ? "" : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`));
};
// The module runs in its own VM realm, so its Set is a different constructor
// than this file's. instanceof would be false for a perfectly good Set; the
// brand check works across realms.
const isSet = (v) => Object.prototype.toString.call(v) === "[object Set]";
const checkNoThrow = (name, fn) => {
  try { fn(); rows.push(`PASS  ${name}`); }
  catch (e) { rows.push(`FAIL  ${name}  (threw ${e && e.message})`); }
};

// ── minimal browser surface the module touches ────────────────────────────
const store = new Map();
const ctx = {
  console: { debug() {}, log() {}, warn() {}, error() {} },
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k)
  },
  fetch: () => Promise.reject(new Error("network disabled in test")),
  setTimeout, clearTimeout, Promise, Date, Math, JSON, URL
};
ctx.window = ctx;
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(src, ctx, { filename: "js/image-resolver.js" });

const ImageResolver = vm.runInContext("ImageResolver", ctx);
check("module exposes ensureSeasonStills", typeof ImageResolver.ensureSeasonStills, "function");

const ensure = ImageResolver.ensureSeasonStills;

// ── the exact production failure, reproduced end to end ───────────────────
{
  const live = { id: 1, tmdbId: 999, _seasonStillsTried: new Set([1]) };
  const revived = JSON.parse(JSON.stringify(live));
  check("a Set really does serialise to {}", revived._seasonStillsTried, {});
  checkNoThrow("JSON round-tripped show does not throw", () => ensure(revived, 1));
  check("the {} was normalised to a real Set", isSet(revived._seasonStillsTried), true);
}

// ── every restored shape the field can come back as ───────────────────────
const shapes = [
  ["undefined", undefined],
  ["null", null],
  ["{} (serialised Set)", {}],
  ["[] (empty array)", []],
  ["[1,2] (array with values)", [1, 2]],
  ["a real Set", new Set([3])]
];
for (const [label, value] of shapes) {
  const anime = { id: 2, tmdbId: 999, _seasonStillsTried: value };
  checkNoThrow(`ensureSeasonStills tolerates ${label}`, () => ensure(anime, 1));
  check(`${label} becomes a Set`, isSet(anime._seasonStillsTried), true);
}

// ── an array's values are preserved, a serialised Set's are not (it has none)
{
  const fromArray = { id: 3, tmdbId: 999, _seasonStillsTried: [7, 8] };
  ensure(fromArray, 1);
  // ensure() also records the season it was asked about (1), so 1 joins 7 and 8.
  check("array values are rehydrated", [...fromArray._seasonStillsTried].sort((a,b)=>a-b), [1, 7, 8]);

  const fromObject = { id: 4, tmdbId: 999, _seasonStillsTried: {} };
  ensure(fromObject, 1);
  check("a serialised Set starts empty, not corrupt", [...fromObject._seasonStillsTried], [1]);
}

// ── the guard still short-circuits a season already tried ─────────────────
{
  const anime = { id: 5, tmdbId: 999, _seasonStillsTried: new Set([2]) };
  checkNoThrow("an already-tried season resolves without throwing", () => ensure(anime, 2));
  check("already-tried season still recorded", anime._seasonStillsTried.has(2), true);
}

// ── a show with no tmdbId must not blow up either ─────────────────────────
checkNoThrow("show without tmdbId resolves", () => ensure({ id: 6 }, 1));
checkNoThrow("undefined show resolves", () => ensure(undefined, 1));

console.log(rows.join("\n"));
const failed = rows.filter((r) => r.startsWith("FAIL")).length;
console.log(failed ? `\n${failed} FAILED` : "\nall season-stills checks passed");
process.exit(failed ? 1 : 0);
