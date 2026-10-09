import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { root, verifyContainerContext } from "./prepare-cloudflare-containers.mjs";

if (process.platform !== "linux") throw new Error("Run the real Worker/container integration on the Linux validation runner");
verifyContainerContext();
const containers = () => execFileSync("docker", ["ps", "--quiet"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
const before = new Set(containers());
const origin = "http://127.0.0.1:4193";
let logs = "";
const child = spawn(process.execPath, [resolve(root, "scripts/cloudflare-containers-cli.mjs"), "dev"], {
  cwd: root, detached: true, stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false", WRANGLER_SEND_METRICS: "false" }
});
child.stdout.on("data", (data) => { logs = (logs + data).slice(-16000); });
child.stderr.on("data", (data) => { logs = (logs + data).slice(-16000); });
let launchError;
child.on("error", (error) => { launchError = error; });
const closed = new Promise((done) => child.on("close", done));
const request = (path, options = {}) => fetch(origin + path, { signal: AbortSignal.timeout(30000), ...options });
const signalGroup = (signal) => {
  try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; }
};

try {
  let listening = false;
  for (let n = 0; n < 120; n++) {
    if (launchError) throw launchError;
    if (child.exitCode !== null) throw new Error("Wrangler exited before local integration: " + logs);
    try {
      const response = await request("/", { signal: AbortSignal.timeout(1000) });
      if (response.ok) { await response.body?.cancel(); listening = true; break; }
      await response.body?.cancel();
    } catch { /* Wait for local compilation/listening, not an upstream provider. */ }
    await sleep(500);
  }
  assert.ok(listening, "Wrangler did not listen: " + logs);
  const start = performance.now();
  const cold = await Promise.all([1, 2, 3].map(async () => {
    const response = await request("/api/health");
    assert.equal(response.status, 200, "Cold API status: " + logs);
    return response.json();
  }));
  for (const health of cold) {
    assert.equal(health.app, "ZenkaiTV");
    assert.equal(health.api, "ready");
    assert.equal(health.cache.persistentCacheDir, "temporary runtime cache");
  }
  const coldMs = Math.round(performance.now() - start);
  for (const path of ["/anime/runtime-fixture", "/watch/runtime-fixture/s1-e1", "/player/player.html"]) {
    const response = await request(path, { redirect: "manual" });
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get("content-type") || "", /text\/html/);
    assert.match(response.headers.get("x-robots-tag") || "", /noindex/);
    await response.body?.cancel();
  }
  const config = await (await request("/api/config")).json();
  assert.equal(config.configured, false);
  assert.equal(config.supabaseKey, "");
  const scanner = await request("/.env");
  assert.equal(scanner.status, 404);
  await scanner.body?.cancel();
  const blocked = await request("/api/source?url=" + encodeURIComponent("http://127.0.0.1:8080/api/health"));
  assert.equal(blocked.status, 502);
  assert.equal((await blocked.json()).ok, false);
  const post = await request("/api/source", { method: "POST", body: "neutral-fixture" });
  assert.equal(post.status, 405);
  await post.body?.cancel();
  for (const encoding of ["gzip", "identity"]) {
    for (let n = 0; n < 2; n++) {
      const response = await request("/api/catalog", { headers: { "Accept-Encoding": encoding } });
      assert.equal(response.status, 200);
      assert.ok(await response.json());
    }
  }
  const media = await request("/api/source?url=" + encodeURIComponent("https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4"),
    { headers: { Range: "bytes=0-3" }, redirect: "manual" });
  assert.equal(media.status, 206);
  assert.match(media.headers.get("content-range") || "", /^bytes 0-3\/\d+$/);
  assert.equal((await media.arrayBuffer()).byteLength, 4);
  const playlist = await request("/api/source?url=" + encodeURIComponent("https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8"));
  assert.equal(playlist.status, 200);
  const manifest = await playlist.text();
  assert.match(manifest, /^#EXTM3U/);
  assert.match(manifest, /\/api\/source\?url=/);
  const warmStart = performance.now();
  assert.equal((await (await request("/api/health")).json()).api, "ready");
  console.log(JSON.stringify({ integration: "Worker -> Durable Object -> Linux container passed", coldConcurrentMs: coldMs,
    warmHealthMs: Math.round(performance.now() - warmStart), note: "Runner/local emulation latency, not hosted Cloudflare performance" }));
} finally {
  if (child.pid) {
    signalGroup("SIGINT");
    await Promise.race([closed, sleep(10000)]);
    if (child.exitCode === null) {
      signalGroup("SIGKILL");
      await closed;
    }
    let remaining = [];
    for (let n = 0; n < 20; n++) {
      remaining = containers().filter((id) => !before.has(id));
      if (!remaining.length) break;
      await sleep(500);
    }
    assert.equal(remaining.length, 0, "Wrangler left running containers after shutdown");
  }
}
