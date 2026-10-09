import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { handleGateway, SECURITY_HEADERS } from "../ops/cloudflare/gateway.mjs";
import { handleProductionGateway } from "../ops/cloudflare/production-gateway.mjs";
import { INTERNAL_ORIGIN } from "../ops/cloudflare/container-runtime.mjs";
import { validateProductionEvent, validateProductionDeployment } from "./cloudflare-production-policy.mjs";

const env = { BACKEND_ORIGIN: INTERNAL_ORIGIN, ASSETS: { fetch: () => new Response("neutral frontend") } };
const options = { containerMedia: true, cache: null, fetchImpl: (_url, init) => {
  assert.equal(init.headers.get("x-zenkai-gateway"), "cloudflare-production");
  return Response.json({ ok: true });
} };

test("only the separate production entry allows live domains and retains all security headers", async () => {
  for (const host of ["zenkaitv.com", "www.zenkaitv.com"]) {
    const request = new Request("https://" + host + "/api/health");
    assert.equal((await handleGateway(request, env, {}, options)).status, 503);
    const live = await handleProductionGateway(request, env, {}, options);
    assert.equal(live.status, 200);
    assert.equal(live.headers.get("x-robots-tag"), null);
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) assert.equal(live.headers.get(key), value);
    assert.deepEqual(await live.json(), { ok: true });
  }
  assert.equal((await handleProductionGateway(new Request("https://unexpected.example/api/health"), env, {}, options)).status, 404);
  const staging = await handleProductionGateway(new Request("https://zenkaitv.juankisantiago.workers.dev/api/health"), env, {}, options);
  assert.equal(staging.headers.get("x-robots-tag"), "noindex, nofollow");
});

test("request headers, query and env cannot opt the staging Worker into production", async () => {
  const response = await handleGateway(new Request("https://zenkaitv.com/api/health?production=true", {
    headers: { "x-zenkai-gateway": "cloudflare-production", "x-production": "true" }
  }), { ...env, production: true }, {}, { fetchImpl: () => { throw new Error("must not call"); } });
  assert.equal(response.status, 503);
});

test("production retains scanner blocking and never retries or caches a failed source", async () => {
  let calls = 0;
  const opts = { ...options, fetchImpl: () => { calls++; return Response.json({ ok: false }, { status: 503, headers: { "Retry-After": "30", "Cache-Control": "no-store" } }); } };
  assert.equal((await handleProductionGateway(new Request("https://zenkaitv.com/.env"), env, {}, opts)).status, 404);
  assert.equal(calls, 0);
  const failed = await handleProductionGateway(new Request("https://zenkaitv.com/api/source?url=opaque"), env, {}, opts);
  assert.equal(failed.status, 503);
  assert.equal(failed.headers.get("retry-after"), "30");
  assert.equal(failed.headers.get("cache-control"), "no-store");
  assert.equal(calls, 1);
});

const approved = { CI: "true", GITHUB_REPOSITORY: "JSolanoDev/AnimeTV", GITHUB_REF: "refs/heads/main",
  GITHUB_EVENT_NAME: "push", CLOUDFLARE_APPROVE_PRODUCTION_DEPLOY: "1", CLOUDFLARE_API_TOKEN: "neutral-fixture" };
const config = JSON.parse(readFileSync("wrangler.production.json", "utf8"));

test("production refuses unapproved CI, branches, DNS changes and expanded capacity", () => {
  validateProductionDeployment(config, approved, {});
  for (const key of Object.keys(approved)) assert.throws(() => validateProductionDeployment(config, { ...approved, [key]: "" }, {}));
  for (const mutation of [{ routes: ["zenkaitv.com/*"] }, { vars: { UNSAFE: "1" } }, { name: "other" },
    { containers: [{ ...config.containers[0], max_instances: 2 }] }, { triggers: { crons: ["* * * * *"] } }]) {
    assert.throws(() => validateProductionDeployment({ ...config, ...mutation }, approved, {}), /Refusing/);
  }
});

test("only successful trusted main catalog workflows may trigger automatic publishing", () => {
  const eventEnv = { ...approved, GITHUB_EVENT_NAME: "workflow_run" };
  const run = { conclusion: "success", head_branch: "main", name: "Scrape anime catalog", head_repository: { full_name: "JSolanoDev/AnimeTV" } };
  validateProductionEvent(eventEnv, { workflow_run: run });
  for (const change of [{ conclusion: "failure" }, { head_branch: "fork" }, { name: "untrusted" }, { head_repository: { full_name: "fork/AnimeTV" } }]) {
    assert.throws(() => validateProductionEvent(eventEnv, { workflow_run: { ...run, ...change } }), /Untrusted/);
  }
  assert.throws(() => validateProductionEvent({ ...approved, GITHUB_EVENT_NAME: "pull_request_target" }, {}));
});

test("daily publishing checks current main, skips unchanged snapshots and records success only after validation", () => {
  const workflow = readFileSync(".github/workflows/cloudflare-production.yml", "utf8");
  assert.match(workflow, /workflow_run:/);
  for (const file of ["scrape-catalog.yml", "refresh-latest-artwork.yml", "refresh-adult-catalog.yml"]) {
    const name = readFileSync(".github/workflows/" + file, "utf8").match(/^name: (.+)/)[1].trim();
    assert.ok(workflow.includes('"' + name + '"'));
  }
  assert.match(workflow, /ref: main/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /vars\.CLOUDFLARE_PRODUCTION_ENABLED == 'true'/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /cache-hit != 'true'/);
  assert.match(workflow, /if: success\(\)/);
  const integration = workflow.indexOf("npm run cloudflare:containers:prepare && npm run cloudflare:containers:integration");
  const productionSnapshot = workflow.indexOf("npm run cloudflare:production:prepare && npm run cloudflare:production:dry-run");
  const deploy = workflow.indexOf("run: npm run cloudflare:production:deploy");
  assert.ok(integration > 0 && integration < productionSnapshot && productionSnapshot < deploy,
    "Staging integration must retain its noindex assets; rebuild production assets before publishing");
  assert.ok(workflow.indexOf("check-cloudflare-hosted-readiness.mjs production") < workflow.indexOf("actions/cache/save@"));
  assert.doesNotMatch(workflow, /contents: write|pull_request|download-artifact|head_sha|ref: \$\{/);
});
