import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { buildInputHash, canReuseStaticBuild, listStaticFiles, validateBuildManifest, verifyLocalBuild, writeBuildManifest } from "./static-build-artifacts.mjs";
import { minifyCssFile, minifyJsFile } from "./build-static.mjs";
import { verifyPublishedBuild } from "./verify-static-build.mjs";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "zenkaitv-static-build-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, "player"));
  for (const name of ["index.html", "client.js", "styles.css", "service-worker.js", "player/player.html", "player/player.js"]) {
    writeFileSync(join(directory, name), `/* neutral fixture: ${name} */`);
  }
  const files = listStaticFiles(directory);
  const hash = buildInputHash(files.map((name) => join(directory, name)), { minifier: "1" });
  return { directory, files, hash, manifest: writeBuildManifest(directory, hash) };
}

test("verified output can be reused without rewriting assets", (t) => {
  const f = fixture(t);
  const before = readFileSync(join(f.directory, "client.js"));
  assert.equal(verifyLocalBuild(f.directory, f.manifest), f.files.length);
  assert.equal(canReuseStaticBuild(f.directory, f.hash, f.files), true);
  assert.deepEqual(readFileSync(join(f.directory, "client.js")), before);
});

test("changed inputs or tool versions invalidate the cached build", (t) => {
  const f = fixture(t);
  assert.equal(canReuseStaticBuild(f.directory, "f".repeat(64), f.files), false);
  const changedTools = buildInputHash(f.files.map((name) => join(f.directory, name)), { minifier: "2" });
  assert.notEqual(changedTools, f.hash);
  writeFileSync(join(f.directory, "client.js"), "/* changed input */");
  assert.notEqual(buildInputHash(f.files.map((name) => join(f.directory, name)), { minifier: "1" }), f.hash);
});

test("tampered, missing, extra, or incomplete output cannot be reused", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.directory, "client.js"), "/* raw replacement */");
  assert.equal(canReuseStaticBuild(f.directory, f.hash, f.files), false);
  assert.throws(() => verifyLocalBuild(f.directory, f.manifest), /differs/);
  rmSync(join(f.directory, "client.js"));
  assert.equal(canReuseStaticBuild(f.directory, f.hash, f.files), false);
  writeFileSync(join(f.directory, "unexpected.js"), "void 0;");
  assert.throws(() => verifyLocalBuild(f.directory, f.manifest), /inventory/);
  assert.equal(canReuseStaticBuild(f.directory, f.hash, [...f.files, "new.js"]), false);
});

test("unsafe asset paths and incomplete manifests fail validation", (t) => {
  const f = fixture(t);
  for (const name of ["../private.js", "/private.js", "//elsewhere/private.js", "player/../private.js", "C:\\private.js"]) {
    assert.throws(() => validateBuildManifest({ ...f.manifest, assets: { ...f.manifest.assets, [name]: f.manifest.assets["client.js"] } }), /Unsafe/);
  }
  const assets = { ...f.manifest.assets };
  delete assets["index.html"];
  assert.throws(() => validateBuildManifest({ ...f.manifest, assets }), /required/);
  assert.throws(() => validateBuildManifest({ ...f.manifest, assets: {
    ...f.manifest.assets, "client.js": { ...f.manifest.assets["client.js"], bytes: 0 }
  } }), /empty required/);
});

test("invalid JavaScript fails minification instead of publishing the raw file", async (t) => {
  const f = fixture(t);
  const path = join(f.directory, "client.js");
  const invalid = "function broken( {";
  writeFileSync(path, invalid);
  await assert.rejects(minifyJsFile(path));
  assert.equal(readFileSync(path, "utf8"), invalid);
});

test("valid and empty JavaScript/CSS produce compact output", async (t) => {
  const f = fixture(t);
  const js = join(f.directory, "client.js");
  const css = join(f.directory, "styles.css");
  writeFileSync(js, "// comment\nfunction demo(value) { return value + 1; }\n");
  writeFileSync(css, "/* comment */\n.test { color: red; }\n");
  assert.ok(await minifyJsFile(js) > 0);
  assert.ok(minifyCssFile(css) > 0);
  assert.doesNotMatch(readFileSync(js, "utf8"), /comment/);
  assert.doesNotMatch(readFileSync(css, "utf8"), /comment/);
  writeFileSync(js, "");
  writeFileSync(css, "");
  assert.equal(await minifyJsFile(js), 0);
  assert.equal(minifyCssFile(css), 0);
});

test("deployment verification catches raw assets and never calls APIs or streams", async (t) => {
  const f = fixture(t);
  const requests = [];
  let raw = false;
  const fetcher = async (url) => {
    requests.push(url.pathname);
    if (url.pathname === "/build-manifest.json") return Response.json(f.manifest);
    const name = decodeURIComponent(url.pathname.slice(1));
    return new Response(raw && name === "client.js" ? "/* unminified replacement */" : readFileSync(join(f.directory, name)));
  };
  const result = await verifyPublishedBuild("https://example.test/", fetcher);
  assert.equal(result.assets, f.files.length);
  assert.ok(requests.every((path) => path === "/build-manifest.json" || /\.(js|css|html)$/.test(path)));
  raw = true;
  await assert.rejects(verifyPublishedBuild("https://example.test/", fetcher), /differs from minified build: client.js/);
  await assert.rejects(verifyPublishedBuild("https://example.test/", async () => new Response("blocked", { status: 403 })), /403/);
});

test("clean Git build configuration rejects missing discovery and duplicate destructive hooks", (t) => {
  const f = fixture(t);
  mkdirSync(join(f.directory, "scraper"));
  mkdirSync(join(f.directory, "api"));
  writeFileSync(join(f.directory, "scraper", "adult_portrait_map.json"), "{}");
  writeFileSync(join(f.directory, "api", "[...path].js"), 'require.resolve("../scraper/adult_portrait_map.json");');
  const config = JSON.parse(readFileSync("vercel.json", "utf8"));
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const check = (scripts, override = config) => {
    writeFileSync(join(f.directory, "package.json"), JSON.stringify({ ...pkg, scripts }));
    writeFileSync(join(f.directory, "vercel.json"), JSON.stringify(override));
    return spawnSync(process.execPath, [resolve("scripts/check-vercel-config.mjs")], { cwd: f.directory, encoding: "utf8" });
  };
  assert.equal(check(pkg.scripts).status, 0);
  assert.equal(check({ ...pkg.scripts, build: undefined }).status, 1);
  assert.equal(check({ ...pkg.scripts, "vercel-build": pkg.scripts.build }).status, 1);
  assert.equal(check({ ...pkg.scripts, "now-build": pkg.scripts.build }).status, 1);
  assert.equal(check(pkg.scripts, { ...config, buildCommand: "" }).status, 1);
  assert.equal(check(pkg.scripts, { ...config, buildCommand: "npm run vercel-build" }).status, 1);
});
