import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync, gunzipSync } from "node:zlib";
import { ContainerBackend, CONTAINER_PORT, INACTIVITY_TIMEOUT_MS, INTERNAL_ORIGIN, containerEnvironment } from "../ops/cloudflare/container-runtime.mjs";
import { handleGateway } from "../ops/cloudflare/gateway.mjs";
import { BACKEND_FILES, contextDirectory, prepareContainerContext, root, verifyContainerContext } from "./prepare-cloudflare-containers.mjs";
import networkPolicy from "../ops/cloudflare/container-network.cjs";
import { smokeContainer } from "./smoke-cloudflare-container.mjs";
import { STAGING_BRANCH, validateStagingDeployment } from "./cloudflare-staging-deploy-policy.mjs";

const health = () => Response.json({ ok: true, app: "ZenkaiTV", api: "ready" });
function fakeContainer(handler = () => Response.json({ ok: true })) {
  const state = { starts: 0, probes: 0, calls: 0, options: null, idle: [] };
  const container = {
    running: false,
    start(options) { this.running = true; state.starts++; state.options = options; },
    async setInactivityTimeout(ms) { state.idle.push(ms); },
    getTcpPort(port) {
      assert.equal(port, CONTAINER_PORT);
      return { async fetch(input, options) {
        const request = input instanceof Request ? input : new Request(input, options);
        if (new URL(request.url).pathname === "/api/health") { state.probes++; return health(); }
        state.calls++;
        return handler(request);
      } };
    }
  };
  return { container, state };
}
const env = { BACKEND_ORIGIN: INTERNAL_ORIGIN, ASSETS: { fetch: () => new Response("unchanged frontend") } };
function gateway(path, options, fetchImpl) {
  return handleGateway(new Request("https://container-staging.example" + path, options), env, {},
    { containerMedia: true, fetchImpl, cache: null });
}

test("concurrent cold requests share one start and local readiness probe; warm requests do not probe", async () => {
  const { container, state } = fakeContainer();
  const backend = new ContainerBackend(container, {});
  await Promise.all(Array.from({ length: 10 }, (_, n) => backend.fetch(new Request(INTERNAL_ORIGIN + "/api/test?n=" + n))));
  assert.equal(state.starts, 1);
  assert.equal(state.probes, 1);
  assert.equal(state.calls, 10);
  assert.deepEqual(state.idle, [INACTIVITY_TIMEOUT_MS]);
  await backend.fetch(new Request(INTERNAL_ORIGIN + "/api/test"));
  assert.equal(state.probes, 1);
  container.running = false;
  await backend.fetch(new Request(INTERNAL_ORIGIN + "/api/test"));
  assert.equal(state.starts, 2);
  assert.equal(state.probes, 2);
});

test("one cancelled caller does not cancel another caller's startup", async () => {
  const { container, state } = fakeContainer();
  const original = container.getTcpPort;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  container.getTcpPort = (port) => ({ async fetch(request, options) {
    if (String(request).includes("/api/health")) await gate;
    return original.call(container, port).fetch(request, options);
  } });
  const backend = new ContainerBackend(container, {});
  const cancelled = new AbortController();
  const first = backend.fetch(new Request(INTERNAL_ORIGIN + "/api/first", { signal: cancelled.signal }));
  const rejected = assert.rejects(first, { name: "AbortError" });
  const second = backend.fetch(new Request(INTERNAL_ORIGIN + "/api/second"));
  cancelled.abort();
  await rejected;
  release();
  assert.equal((await second).status, 200);
  assert.equal(state.starts, 1);
  assert.equal(state.calls, 1);
});

test("already cancelled requests and non-API paths never start a container", async () => {
  const { container, state } = fakeContainer();
  const backend = new ContainerBackend(container, {});
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(backend.fetch(new Request(INTERNAL_ORIGIN + "/api/test", { signal: controller.signal })), { name: "AbortError" });
  assert.equal((await backend.fetch(new Request(INTERNAL_ORIGIN + "/.env"))).status, 404);
  assert.equal(state.starts, 0);
});

test("slow or failed startup is bounded and does not attempt episode or source requests", async () => {
  const { container, state } = fakeContainer();
  container.getTcpPort = () => ({ fetch: (_request, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new DOMException("timeout", "AbortError")), { once: true });
  }) });
  const backend = new ContainerBackend(container, {}, { readinessTimeoutMs: 20, probeDelayMs: 1 });
  const result = await backend.fetch(new Request(INTERNAL_ORIGIN + "/api/source?url=opaque"));
  assert.equal(result.status, 503);
  assert.equal(result.headers.get("cache-control"), "no-store");
  assert.equal(state.calls, 0);
  assert.equal(state.starts, 1);
  container.getTcpPort = fakeContainer().container.getTcpPort;
  assert.equal((await backend.fetch(new Request(INTERNAL_ORIGIN + "/api/test"))).status, 200);
  assert.equal(state.starts, 1);
});

test("failed source delivery is never retried by the container controller", async () => {
  const { container, state } = fakeContainer(() => { throw new Error("source outage"); });
  const backend = new ContainerBackend(container, {});
  await assert.rejects(backend.fetch(new Request(INTERNAL_ORIGIN + "/api/source?url=opaque")), /source outage/);
  assert.equal(state.calls, 1);
});

test("only explicitly allowed runtime secrets are passed and public config rejects privileged Supabase keys", () => {
  const values = containerEnvironment({ TMDB_READ_ACCESS_TOKEN: "test-token", SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
    SUPABASE_SERVICE_ROLE_KEY: "never-copy", VERCEL_TOKEN: "never-copy", HOME: "never-copy", PORT: "9999" });
  assert.equal(values.TMDB_READ_ACCESS_TOKEN, "test-token");
  assert.equal(values.PORT, "8080");
  assert.equal(values.ZENKAI_HOSTED_RUNTIME, "1");
  assert.equal(values.SUPABASE_SERVICE_ROLE_KEY, undefined);
  assert.equal(values.VERCEL_TOKEN, undefined);
  const jwt = (role) => "test." + Buffer.from(JSON.stringify({ role })).toString("base64url") + ".test";
  assert.equal(containerEnvironment({ SUPABASE_ANON_KEY: jwt("anon") }).SUPABASE_ANON_KEY, jwt("anon"));
  assert.throws(() => containerEnvironment({ SUPABASE_ANON_KEY: jwt("service_role") }), /public Supabase/);
  assert.throws(() => containerEnvironment({ SUPABASE_PUBLISHABLE_KEY: "sb_secret_test" }), /public Supabase/);
});

test("container gateway streams neutral MP4 ranges without redirecting, retrying, or caching playback", async () => {
  let calls = 0;
  const response = await gateway("/api/source?url=https%3A%2F%2Fmedia.example%2Fneutral.mp4", { headers: { Range: "bytes=0-3" } }, (_url, options) => {
    calls++;
    assert.equal(options.headers.get("range"), "bytes=0-3");
    return new Response(new Uint8Array([0, 1, 2, 3]), { status: 206, headers: {
      "Content-Type": "video/mp4", "Content-Range": "bytes 0-3/100", "Accept-Ranges": "bytes", "Cache-Control": "no-store"
    } });
  });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("location"), null);
  assert.equal(response.headers.get("content-range"), "bytes 0-3/100");
  assert.equal(response.headers.get("x-zenkai-gateway-cache"), "BYPASS");
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [0, 1, 2, 3]);
  assert.equal(calls, 1);
});

test("HLS manifests, HEAD, OPTIONS and compressed JSON keep their existing wire format", async () => {
  const manifest = "#EXTM3U\n#EXTINF:4,\n/api/source?url=opaque-segment\n";
  const hls = await gateway("/api/source?url=opaque-manifest", {}, () => new Response(manifest, { headers: { "Content-Type": "application/vnd.apple.mpegurl" } }));
  assert.equal(await hls.text(), manifest);
  const head = await gateway("/api/source?url=opaque", { method: "HEAD" }, () => new Response(null, { headers: { "Content-Type": "video/mp4", "Content-Length": "1234" } }));
  assert.equal(head.headers.get("content-length"), "1234");
  assert.equal(await head.text(), "");
  const preflight = await gateway("/api/source", { method: "OPTIONS" }, () => { throw new Error("must not fetch"); });
  assert.equal(preflight.status, 204);
  const compressed = gzipSync('{"ok":true}');
  const json = await gateway("/api/test", {}, () => new Response(compressed, { headers: { "Content-Type": "application/json", "Content-Encoding": "gzip" } }));
  assert.equal(gunzipSync(Buffer.from(await json.arrayBuffer())).toString(), '{"ok":true}');
});

test("stream cancellation aborts the original backend request after response headers arrive", async () => {
  let signal;
  let cancelled = false;
  const response = await gateway("/api/source?url=opaque", {}, (_url, options) => {
    signal = options.signal;
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "Content-Type": "video/mp4" } });
  });
  await response.body.cancel();
  assert.equal(signal.aborted, true);
  assert.equal(cancelled, true);
});

test("container mode still protects production hosts, scanner paths and unexpected media routes", async () => {
  const never = () => { throw new Error("must not fetch"); };
  assert.equal((await gateway("/.env", {}, never)).status, 404);
  assert.equal((await gateway("/api/source", { method: "POST" }, never)).status, 405);
  assert.equal((await handleGateway(new Request("https://zenkaitv.com/api/health"), env, {}, { containerMedia: true, fetchImpl: never })).status, 503);
  const blocked = await gateway("/api/test", {}, () => new Response("opaque", { headers: { "Content-Type": "video/mp4" } }));
  assert.equal(blocked.status, 502);
  assert.equal(await (await gateway("/anime/neutral", {}, never)).text(), "unchanged frontend");
});

test("build context copies only required files and detects stale, injected and altered inputs", () => {
  const files = prepareContainerContext();
  assert.ok(files["package-lock.json"]);
  assert.equal(Object.keys(files).length, BACKEND_FILES.length + 3);
  assert.ok(!Object.keys(files).some((name) => /\.env|\.vercel|\.git|settings|ssh/.test(name)));
  verifyContainerContext();
  writeFileSync(join(contextDirectory, "unexpected-token.txt"), "synthetic-only");
  assert.throws(verifyContainerContext, /Unexpected container input/);
  unlinkSync(join(contextDirectory, "unexpected-token.txt"));
  const entry = join(contextDirectory, "container-entry.cjs");
  const original = readFileSync(entry);
  writeFileSync(entry, "// altered fixture\n");
  assert.throws(verifyContainerContext, /Stale or modified/);
  writeFileSync(entry, original);
  verifyContainerContext();
});

test("sanitized Node entry starts with hosted safeguards and handles neutral API requests", { timeout: 15000 }, async () => {
  prepareContainerContext();
  const child = spawn(process.execPath, [join(contextDirectory, "container-entry.cjs")], {
    cwd: contextDirectory, stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
      NODE_PATH: join(root, "node_modules"), HOST: "127.0.0.1", PORT: "0", ANIME1V_AUTO_START: "false" }
  });
  const exited = once(child, "exit");
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Node entry did not start")), 10000);
      child.once("error", reject);
      child.once("exit", () => { clearTimeout(timer); reject(new Error("Node entry exited early")); });
      child.stdout.on("data", (data) => {
        const match = data.toString().match(/ready on port (\d+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
    });
    const origin = "http://127.0.0.1:" + port;
    const healthResponse = await fetch(origin + "/api/health");
    assert.equal(healthResponse.headers.get("strict-transport-security")?.startsWith("max-age="), true);
    const payload = await healthResponse.json();
    assert.equal(payload.app, "ZenkaiTV");
    assert.equal(payload.cache.persistentCacheDir, "temporary runtime cache");
    assert.equal(payload.dailyRefresh.status, "waiting");
    const config = await (await fetch(origin + "/api/config")).json();
    assert.equal(config.configured, false);
    assert.equal(config.supabaseKey, "");
    const blocked = await fetch(origin + "/api/source?url=" + encodeURIComponent(origin + "/api/health"));
    assert.equal(blocked.status, 502);
    assert.equal((await blocked.json()).ok, false);
    assert.equal((await fetch(origin + "/.env")).status, 404);
  } finally {
    child.kill();
    await exited;
  }
});

test("container-only network policy blocks private, reserved and mapped addresses", () => {
  for (const address of ["127.0.0.1", "10.1.2.3", "192.168.0.169", "169.254.169.254", "100.64.1.1",
    "0.0.0.0", "224.0.0.1", "240.0.0.1", "198.18.0.1", "::1", "::ffff:127.0.0.1", "fc00::1",
    "fe80::1", "2001:db8::1", "2002:7f00:1::1", "64:ff9b::7f00:1"]) assert.equal(networkPolicy.isPublicAddress(address), false, address);
  for (const address of ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111", "2001:4860:4860::8888"]) {
    assert.equal(networkPolicy.isPublicAddress(address), true, address);
  }
});

test("outbound sockets use exactly the validated DNS result and reject mixed public/private answers", async () => {
  let answers = [{ address: "1.1.1.1", family: 4 }];
  let lookups = 0;
  let connections = 0;
  const connect = networkPolicy.createPublicConnector({
    lookup(_hostname, options, callback) { lookups++; assert.equal(options.all, true); callback(null, answers); },
    connectorFactory(options) { return (target, callback) => {
      connections++;
      options.lookup(target.hostname, { all: true }, callback);
    }; }
  });
  const request = (hostname) => new Promise((resolve, reject) => connect({ hostname }, (error, result) => error ? reject(error) : resolve(result)));
  assert.deepEqual(await request("media.example"), answers);
  assert.equal(lookups, 1);
  await assert.rejects(request("127.0.0.1"), { code: "ZENKAI_PRIVATE_ADDRESS" });
  assert.equal(connections, 1);
  answers = [{ address: "1.1.1.1", family: 4 }, { address: "10.0.0.1", family: 4 }];
  await assert.rejects(request("redirect.example"), { code: "ZENKAI_PRIVATE_ADDRESS" });
  assert.equal(lookups, 2);
});

test("staging config and CLI restrict deployments and cannot change DNS or enable unbounded containers", () => {
  const config = JSON.parse(readFileSync(join(root, "wrangler.container-staging.json"), "utf8"));
  assert.equal(config.containers.length, 1);
  assert.equal(config.containers[0].max_instances, 1);
  assert.equal(config.containers[0].scheduling_policy, "default");
  assert.ok(config.compatibility_flags.includes("enable_request_signal"));
  assert.equal(config.routes, undefined);
  assert.equal(config.triggers, undefined);
  assert.equal(config.vars, undefined);
  const cli = readFileSync(join(root, "scripts/cloudflare-containers-cli.mjs"), "utf8");
  assert.match(cli, /"--dry-run"/);
  assert.match(cli, /validateStagingDeployment/);
  assert.doesNotMatch(cli, /"deploy-production"/);
  assert.equal(JSON.parse(readFileSync(join(root, "wrangler.staging.json"), "utf8")).vars.BACKEND_ORIGIN, "https://zenkaitv.com");
  const workflow = readFileSync(join(root, ".github/workflows/cloudflare-container-check.yml"), "utf8");
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /push:\s+branches: \["cloudflare-validation\/\*\*"\]/);
  assert.doesNotMatch(workflow, /secrets\.|contents: write|schedule:|deploy:staging|branches: \[main\]/);
});

test("hosted deployment requires explicit approval and the exact repository and staging branch", () => {
  const config = JSON.parse(readFileSync(join(root, "wrangler.container-staging.json"), "utf8"));
  const approved = { CI: "true", GITHUB_REPOSITORY: "JSolanoDev/AnimeTV", GITHUB_REF: "refs/heads/" + STAGING_BRANCH,
    CLOUDFLARE_APPROVE_STAGING_DEPLOY: "1", CLOUDFLARE_API_TOKEN: "neutral-fixture" };
  validateStagingDeployment(config, approved);
  for (const key of Object.keys(approved)) {
    assert.throws(() => validateStagingDeployment(config, { ...approved, [key]: "" }), /requires/);
  }
  assert.throws(() => validateStagingDeployment(config, { ...approved, GITHUB_REF: "refs/heads/main" }), /requires/);
  for (const mutation of [{ name: "zenkaitv-production" }, { routes: ["zenkaitv.com/*"] }, { triggers: { crons: ["* * * * *"] } },
    { containers: [{ ...config.containers[0], max_instances: 2 }] }]) {
    assert.throws(() => validateStagingDeployment({ ...config, ...mutation }, approved), /Refusing/);
  }
  const workflow = readFileSync(join(root, ".github/workflows/cloudflare-container-staging.yml"), "utf8");
  assert.match(workflow, /branches: \["cloudflare-staging\/container-staging-2026-10-09"\]/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /secrets\.CLOUDFLARE_STAGING_API_TOKEN/);
  assert.doesNotMatch(workflow, /schedule:|contents: write|branches: \[main\]/);
});

test("Docker smoke harness uses a loopback-only, resource-limited container without credentials and always stops it", async () => {
  const commands = [];
  const run = async (args) => {
    commands.push(args);
    return { stdout: args[0] === "inspect" ? '[{"HostIp":"127.0.0.1","HostPort":"12345"}]' : "" };
  };
  const request = async (url) => {
    if (url.includes("/api/source")) return Response.json({ ok: false }, { status: 502 });
    if (url.endsWith("/.env")) return new Response(null, { status: 404 });
    if (url.endsWith("/api/config")) return Response.json({ configured: false, supabaseKey: "" });
    return Response.json({ app: "ZenkaiTV", api: "ready", cache: { persistentCacheDir: "temporary runtime cache" }, dailyRefresh: { status: "waiting" } });
  };
  await smokeContainer({ run, request });
  assert.equal(commands[0][commands[0].indexOf("--publish") + 1], "127.0.0.1::8080");
  assert.ok(commands[0].includes("--read-only"));
  assert.ok(!commands[0].some((arg) => /env-file|SUPABASE|TOKEN|--volume/.test(arg)));
  assert.equal(commands.at(-1)[0], "stop");
  commands.length = 0;
  await assert.rejects(smokeContainer({ run, request: () => Response.json({}), sleep: async () => {} }), /Container API/);
  assert.equal(commands.at(-1)[0], "stop");
});
