import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
export async function smokeContainer({ run = (args) => execFileAsync("docker", args, { timeout: 60000, maxBuffer: 65536 }),
  request = fetch, sleep = (ms) => new Promise((done) => setTimeout(done, ms)), network = false } = {}) {
  const name = "zenkai-verify-" + process.pid + "-" + Date.now();
  let started = false;
  try {
    await run(["run", "--detach", "--rm", "--name", name, "--publish", "127.0.0.1::8080",
      "--memory", "1g", "--cpus", "0.25", "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=128m",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "zenkaitv-container-staging:local"]);
    started = true;
    const { stdout } = await run(["inspect", "--format", '{{json (index .NetworkSettings.Ports "8080/tcp")}}', name]);
    const bindings = JSON.parse(stdout);
    assert.equal(bindings[0].HostIp, "127.0.0.1");
    assert.match(bindings[0].HostPort, /^\d+$/);
    const origin = "http://127.0.0.1:" + bindings[0].HostPort;
    let payload;
    for (let n = 0; n < 30; n++) {
      try {
        const response = await request(origin + "/api/health", { signal: AbortSignal.timeout(2000) });
        if (response.ok) { payload = await response.json(); break; }
      } catch { /* Wait only for the local image to listen; never retry a source. */ }
      await sleep(500);
    }
    assert.equal(payload?.app, "ZenkaiTV", "Container API did not become ready");
    assert.equal(payload.api, "ready");
    assert.equal(payload.cache.persistentCacheDir, "temporary runtime cache");
    assert.equal(payload.dailyRefresh.status, "waiting");
    const config = await (await request(origin + "/api/config", { signal: AbortSignal.timeout(5000) })).json();
    assert.equal(config.configured, false);
    assert.equal(config.supabaseKey, "");
    const blocked = await request(origin + "/api/source?url=" + encodeURIComponent("http://127.0.0.1:8080/api/health"), { signal: AbortSignal.timeout(5000) });
    assert.equal(blocked.status, 502);
    assert.equal((await blocked.json()).ok, false);
    const scanner = await request(origin + "/.env", { signal: AbortSignal.timeout(5000) });
    assert.equal(scanner.status, 404);
    await scanner.body?.cancel();
    const sharp = await run(["exec", name, "node", "-e", "require('sharp')({create:{width:2,height:2,channels:3,background:'#000000'}}).webp().toBuffer().then(b=>{if(!b.length)process.exit(1)}).catch(()=>process.exit(1))"]);
    assert.ok(sharp);
    if (network) {
      const media = await request(origin + "/api/source?url=" + encodeURIComponent("https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4"),
        { headers: { Range: "bytes=0-3" }, signal: AbortSignal.timeout(20000) });
      assert.equal(media.status, 206);
      assert.match(media.headers.get("content-range") || "", /^bytes 0-3\/\d+$/);
      assert.equal((await media.arrayBuffer()).byteLength, 4);
      const hls = await request(origin + "/api/source?url=" + encodeURIComponent("https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8"),
        { signal: AbortSignal.timeout(20000) });
      assert.equal(hls.status, 200);
      const manifest = await hls.text();
      assert.match(manifest, /^#EXTM3U/);
      assert.match(manifest, /\/api\/source\?url=/);
    }
    return { memory: payload.memory, neutralMediaChecked: network };
  } finally {
    if (started) await run(["stop", "--time", "30", name]);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await smokeContainer({ network: process.argv.includes("--network") });
    console.log("Linux container health, public config, scanner/SSRF guard and native Sharp passed:", JSON.stringify(result));
  } catch (error) {
    console.error("Container runtime validation failed:", error.code === "ENOENT" ? "Docker is not installed" : error.message);
    process.exitCode = 1;
  }
}
