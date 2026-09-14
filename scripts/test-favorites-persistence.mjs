import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const client = readFileSync(new URL("../client.js", import.meta.url), "utf8");

function section(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `missing source section: ${start}`);
  return source.slice(from, to);
}

function storageSize(entries) {
  return [...entries].reduce((total, [key, value]) => total + key.length + String(value).length, 0);
}

function quotaStorage(seed, limit) {
  const entries = new Map(Object.entries(seed).map(([key, value]) => [key, String(value)]));
  return {
    get length() { return entries.size; },
    key(index) { return [...entries.keys()][index] ?? null; },
    getItem(key) { return entries.has(key) ? entries.get(key) : null; },
    removeItem(key) { entries.delete(key); },
    setItem(key, value) {
      const next = new Map(entries);
      next.set(key, String(value));
      if (storageSize(next) > limit) {
        const error = new Error("Storage quota exceeded");
        error.name = "QuotaExceededError";
        throw error;
      }
      entries.clear();
      next.forEach((entryValue, entryKey) => entries.set(entryKey, entryValue));
    }
  };
}

function favoritesHarness() {
  const context = vm.createContext({ localStorage: quotaStorage({}, Infinity), Set, JSON, String, Array });
  vm.runInContext(
    section(client, "const FAVORITES_STORAGE_KEY", "const state ="),
    context
  );
  return context;
}

test("favorites recover from quota pressure without deleting durable state", () => {
  const context = favoritesHarness();
  const seed = {
    "anime-tv-favorites": "[]",
    "animetv-resume-positions": "r".repeat(180),
    "animetv-response-cache:catalog": "c".repeat(320)
  };
  const currentSize = storageSize(Object.entries(seed));
  const storage = quotaStorage(seed, currentSize + 5);

  assert.equal(context.persistFavoriteIds(["naruto", "naruto", 20], storage), true);
  assert.deepEqual(JSON.parse(storage.getItem("anime-tv-favorites")), ["naruto", "20"]);
  assert.equal(storage.getItem("animetv-response-cache:catalog"), null);
  assert.equal(storage.getItem("animetv-resume-positions"), seed["animetv-resume-positions"]);
});

test("favorites tolerate corrupt or unavailable browser storage", () => {
  const context = favoritesHarness();
  const corrupt = quotaStorage({ "anime-tv-favorites": "{bad-json" }, Infinity);
  const disabled = {
    get length() { throw new Error("disabled"); },
    getItem() { throw new Error("disabled"); },
    setItem() { throw new Error("disabled"); },
    removeItem() { throw new Error("disabled"); },
    key() { throw new Error("disabled"); }
  };

  assert.deepEqual(Array.from(context.readFavoriteIds(corrupt)), []);
  assert.equal(context.persistFavoriteIds(["bleach"], disabled), false);
});
