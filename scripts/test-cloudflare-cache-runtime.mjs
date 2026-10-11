import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

// Use the repository's pinned toolchain without adding runtime dependencies or reading dotenv credentials.
const packageFile = process.env.PATH.split(delimiter).map((directory) => join(directory, "..", "wrangler", "package.json")).find(existsSync);
assert.ok(packageFile, "Run: npm exec --yes --package=wrangler@4.149.0 -- node scripts/test-cloudflare-cache-runtime.mjs");
const require = createRequire(packageFile);
assert.equal(require(packageFile).version, "4.149.0");
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");
const worker = new Miniflare(convertV4MiniflareOptions({ modules: [
  { type: "ESModule", path: resolve("scripts/fixtures/cloudflare-cache-worker.mjs") },
  { type: "ESModule", path: resolve("ops/cloudflare/gateway.mjs") }
], compatibilityDate: "2026-10-08",
  compatibilityFlags: ["enable_request_signal"] }));
const request = (path, init) => worker.dispatchFetch("https://staging.example" + path, init);

try {
  for (const encoding of ["identity", "gzip"]) {
    for (let n = 0; n < 2; n++) {
      const response = await request("/api/tmdb/search?q=neutral&encoding=" + encoding);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-zenkai-gateway-cache"), n ? "HIT" : "MISS", `${encoding} round ${n}`);
      assert.equal(response.headers.get("cache-control"), "public, max-age=120, s-maxage=600");
      assert.equal(response.headers.get("etag"), '"neutral-v1"');
      assert.equal(response.headers.has("x-zenkai-cache-policy"), false);
      assert.equal((await response.json()).fixture, "neutral");
      if (!n) await sleep(150);
    }
  }
  for (const status of [429, 502]) {
    for (let n = 0; n < 2; n++) {
      const response = await request("/api/tmdb/search?q=neutral&status=" + status);
      assert.equal(response.status, status);
      assert.equal(response.headers.get("x-zenkai-gateway-cache"), "MISS");
      await response.text();
      if (!n) await sleep(150);
    }
  }
  const privateResponse = await request("/api/tmdb/search?q=neutral&encoding=identity", { headers: { Cookie: "session=neutral" } });
  assert.equal(privateResponse.headers.get("x-zenkai-gateway-cache"), "BYPASS");
  await privateResponse.text();
  assert.equal((await request("/.env")).status, 404);
  console.log("Local workerd Cache API passed: metadata MISS/HIT, JSON/gzip, origin policy, validators, privacy, errors and scanner blocking.");
} finally {
  await worker.dispose();
}
