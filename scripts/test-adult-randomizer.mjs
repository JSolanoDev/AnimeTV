import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const client = readFileSync(new URL("../client.js", import.meta.url), "utf8");
const start = client.indexOf("function adultRandomShowIdentity(");
const end = client.indexOf("function catalogShows(", start);
const context = vm.createContext({
  getShowKey: (show) => `title-${show.title || "untitled"}`,
  Math
});
vm.runInContext(client.slice(start, end), context);

const shows = [
  { id: "one", title: "Neutral Series One" },
  { id: "two", title: "Neutral Series Two" },
  { id: "three", title: "Neutral Series Three" }
];

test("random catalog selection excludes the open and previous title", () => {
  const selected = context.pickRandomAdultShow(shows, ["one", "two"], () => 0);
  assert.equal(selected.id, "three");
});

test("two-title catalogs still move away from the current title", () => {
  const selected = context.pickRandomAdultShow(shows.slice(0, 2), ["one", "two"], () => 0.9);
  assert.equal(selected.id, "two");
});

test("duplicate entries are removed before choosing", () => {
  const selected = context.pickRandomAdultShow([shows[0], { ...shows[0] }, shows[1]], [], () => 0.99);
  assert.equal(selected.id, "two");
});

test("selection does not mutate the catalog and handles empty input", () => {
  const original = shows.map((show) => show.id);
  assert.equal(context.pickRandomAdultShow([], [], () => 0), null);
  context.pickRandomAdultShow(shows, [], () => 0.5);
  assert.deepEqual(shows.map((show) => show.id), original);
});
