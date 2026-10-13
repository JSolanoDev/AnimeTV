import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../player/player.js", import.meta.url), "utf8");
const start = source.indexOf("  function scheduleRecovery(");
const end = source.indexOf("  function captureArtworkFrame(", start);
assert.ok(start >= 0 && end > start);

function video(position = 90) {
  const listeners = new Map();
  return {
    currentTime: position, paused: false, ended: false, readyState: 1, loads: 0, plays: 0,
    addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener(type, fn) { if (listeners.get(type) === fn) listeners.delete(type); },
    emit(type) { listeners.get(type)?.(); },
    load() { this.loads++; this.currentTime = 0; this.readyState = 0; },
    play() { this.plays++; this.paused = false; return Promise.resolve(); },
    listenerCount() { return listeners.size; }
  };
}

function context(media = video()) {
  const timers = new Map();
  let id = 0;
  const sandbox = vm.createContext({
    art: { video: media }, hls: null, recoveryTimer: null, recoveryReloadCleanup: null,
    playerCleanups: [], recoveryCount: 0, seekRecoveryUntil: 0,
    document: { hidden: false }, elements: { error: { hidden: true } },
    Date: { now: () => 10000 },
    setTimeout(fn) { timers.set(++id, fn); return id; },
    clearTimeout(key) { timers.delete(key); },
    bufferedAhead: () => 0, playableDuration: () => 1400, getStatus: () => ({}), send() {},
    cancelRebufferObservation() {}, resetPlaybackHealth() {}, clearStallWatchdog() {}
  });
  vm.runInContext(source.slice(start, end), sandbox);
  return { sandbox, media, fire() {
    const [key, callback] = timers.entries().next().value || [];
    assert.ok(callback, "recovery timer exists");
    timers.delete(key);
    callback();
  }, pending: () => timers.size };
}

test("a stalled MP4 reload restores the latest seek position when metadata returns", () => {
  const c = context();
  c.sandbox.scheduleRecovery("waiting");
  c.media.currentTime = 120;
  c.fire();
  assert.equal(c.media.loads, 1);
  c.media.readyState = 1;
  c.media.emit("loadedmetadata");
  assert.equal(c.media.currentTime, 120);
  assert.equal(c.media.listenerCount(), 0);
  assert.equal(c.media.plays, 1);
});

test("queued recovery respects a later pause, end or hidden document", () => {
  for (const change of [c => { c.media.paused = true; }, c => { c.media.ended = true; },
    c => { c.sandbox.document.hidden = true; }]) {
    const c = context();
    c.sandbox.scheduleRecovery("waiting");
    change(c);
    c.fire();
    assert.equal(c.media.loads, 0);
    assert.equal(c.media.plays, 0);
    assert.equal(c.sandbox.recoveryCount, 0);
  }
});

test("an old recovery timer cannot load or resume a replacement player", () => {
  const c = context();
  c.sandbox.scheduleRecovery("waiting");
  const replacement = video(250);
  c.sandbox.art.video = replacement;
  c.fire();
  assert.equal(replacement.loads, 0);
  assert.equal(replacement.plays, 0);
  assert.equal(c.media.loads, 0);
});

test("healthy buffered playback does not reload and HLS retains its existing startLoad path", () => {
  const c = context();
  c.sandbox.bufferedAhead = () => 3;
  c.sandbox.scheduleRecovery("waiting");
  assert.equal(c.pending(), 0);
  c.sandbox.bufferedAhead = () => 0;
  const positions = [];
  c.sandbox.hls = { startLoad(position) { positions.push(position); } };
  c.sandbox.scheduleRecovery("waiting");
  c.fire();
  assert.deepEqual(positions, [90]);
  assert.equal(c.media.loads, 0);
  assert.equal(c.media.plays, 1);
});

test("an explicit new seek or teardown cancels an obsolete reload position listener", () => {
  const c = context();
  c.sandbox.scheduleRecovery("waiting");
  c.fire();
  c.media.currentTime = 200;
  c.sandbox.armSeekRecoveryGrace();
  c.media.emit("loadedmetadata");
  assert.equal(c.media.currentTime, 200);
  assert.equal(c.media.listenerCount(), 0);
  const next = context();
  next.sandbox.scheduleRecovery("waiting");
  next.fire();
  for (const cleanup of next.sandbox.playerCleanups) cleanup();
  assert.equal(next.media.listenerCount(), 0);
});

test("MP4 recovery remains bounded at two reloads and does not change the media URL", () => {
  const c = context();
  c.media.src = "https://media.test/sample.mp4?session=fixture";
  for (let count = 0; count < 3; count++) {
    c.media.currentTime = 300;
    c.sandbox.scheduleRecovery("waiting");
    c.fire();
    c.media.emit("loadedmetadata");
  }
  assert.equal(c.media.loads, 2);
  assert.equal(c.media.src, "https://media.test/sample.mp4?session=fixture");
});

function progressContext() {
  const media = video(120);
  const handlers = {};
  const sandbox = vm.createContext({
    art: { video: media, on(name, callback) { handlers[name] = callback; } },
    video: media, lastProgressPosition: 120, seekRecoveryUntil: 0, recoveryReloadCleanup: null,
    recoveryCount: 2, networkRecoveryCount: 1, mediaRecoveryCount: 1,
    Date: { now: () => 10000 }, clearStallWatchdog() {}, finishRebufferObservation() {},
    captureArtworkFrame() {}, syncSkipSegments() {}, send() {}, getStatus: () => ({})
  });
  const from = source.indexOf('    art.on("video:timeupdate",');
  const to = source.indexOf('    art.on("error",', from);
  assert.ok(from >= 0 && to > from);
  vm.runInContext(source.slice(from, to), sandbox);
  return { sandbox, media, update: () => handlers["video:timeupdate"]() };
}

test("seek jumps and a reload resetting time to zero do not replenish retry budgets", () => {
  for (const change of [c => { c.media.seeking = true; c.media.currentTime = 600; },
    c => { c.sandbox.seekRecoveryUntil = 18000; c.media.currentTime = 30; },
    c => { c.sandbox.recoveryReloadCleanup = () => {}; c.media.currentTime = 0; }]) {
    const c = progressContext();
    change(c);
    c.update();
    assert.equal(c.sandbox.recoveryCount, 2);
    assert.equal(c.sandbox.networkRecoveryCount, 1);
    assert.equal(c.sandbox.mediaRecoveryCount, 1);
  }
});

test("real playback progress still resets the retry budget", () => {
  const c = progressContext();
  c.media.currentTime = 120.3;
  c.update();
  assert.equal(c.sandbox.recoveryCount, 0);
  assert.equal(c.sandbox.networkRecoveryCount, 0);
  assert.equal(c.sandbox.mediaRecoveryCount, 0);
});
