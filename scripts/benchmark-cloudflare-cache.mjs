import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { handleGateway } from "../ops/cloudflare/gateway.mjs";

// Compare the same neutral, bounded workload against the audited base, never production providers.
const base = "d8e635d08a59569bcf79a0de66f165dcc509b160";
const source = execFileSync("git", ["show", `${base}:ops/cloudflare/gateway.mjs`], { encoding: "utf8" });
const before = (await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"))).handleGateway;
const payload = JSON.stringify({ ok: true, configured: true, results: [{ id: 1 }],
  show: { id: 1 }, season: { episodes: [{ id: 1 }] }, items: [{ id: "neutral-fixture" }] });
const paths = ["/api/tmdb/search?q=neutral", "/api/tmdb/season?id=1&season=1", "/api/anilist/airing", "/api/animeav1/latest"];
const percentile = (samples, p) => Number([...samples].sort((a, b) => a - b)[Math.ceil(samples.length * p) - 1].toFixed(2));

async function measure(handler) {
  const entries = new Map();
  const tasks = [];
  let backendCalls = 0;
  let hits = 0;
  const samples = [];
  const options = {
    cache: { match: async (key) => entries.get(key.url)?.clone(), put: async (key, response) => entries.set(key.url, response.clone()) },
    fetchImpl: async () => {
      backendCalls++;
      await sleep(25);
      return new Response(payload, { headers: { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(payload)),
        "Cache-Control": "public, max-age=120, s-maxage=600" } });
    }
  };
  for (let round = 0; round < 20; round++) {
    await Promise.all(paths.map(async (path) => {
      const start = performance.now();
      const response = await handler(new Request("https://staging.example" + path), { BACKEND_ORIGIN: "https://backend.example" },
        { waitUntil: (task) => tasks.push(task) }, options);
      assert.equal(response.status, 200);
      assert.equal(await response.text(), payload);
      if (response.headers.get("x-zenkai-gateway-cache") === "HIT") hits++;
      samples.push(performance.now() - start);
    }));
    await Promise.all(tasks.splice(0));
  }
  return { gatewayInvocations: samples.length, backendCalls, cacheHits: hits, hitPercent: hits / samples.length * 100,
    latencyP50Ms: percentile(samples, 0.5), latencyP95Ms: percentile(samples, 0.95) };
}

const baseline = await measure(before);
const optimized = await measure(handleGateway);
assert.equal(baseline.backendCalls, 80);
assert.equal(optimized.backendCalls, 4);
assert.equal(optimized.cacheHits, 76);
console.log(JSON.stringify({ scope: "Local neutral simulation; four concurrent requests, 20 rounds, 25ms fixture backend delay",
  base, baseline, optimized, backendCallReductionPercent: 95,
  note: "Cache API still executes the Worker. This does not measure hosted latency, CPU billing, or real-world hit rates." }, null, 2));
