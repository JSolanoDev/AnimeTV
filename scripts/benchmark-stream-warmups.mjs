import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import vm from "node:vm";

const base = "e746d05606dfa77193e09b6a12fd07cb3b8bef03";
const baseline = execFileSync("git", ["show", `${base}:client.js`], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
const candidate = readFileSync(new URL("../client.js", import.meta.url), "utf8");
const extract = source => source.slice(source.indexOf("function warmPlayableStream("), source.indexOf("function warmEpisodeSourceById("));
const records = new Map();
const chunk = Buffer.alloc(32 * 1024);
let origin;

const helpers = `const playableStreamWarmups=new Map(), PLAYABLE_STREAM_WARMUP_TTL=30000;
const resolveSourceEndpoint=v=>v, originalStreamUrlFromProxy=v=>v, proxiedStreamUrl=v=>v;
const preconnectStreamOrigin=()=>{}, streamTypeFromUrl=v=>v.includes('.mp4')?'file':'';`;
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://fixture.test");
  if (url.pathname === "/counters") {
    response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end(JSON.stringify([...records.values()]));
    return;
  }
  if (url.pathname === "/media.mp4") {
    const record = { name: url.searchParams.get("case"), bytesWritten: 0, chunks: 0, closed: false, range: request.headers.range };
    records.set(record.name, record);
    // Deliberately ignore Range; cap this neutral response at twenty chunks.
    response.writeHead(200, { "Content-Type": "video/mp4", "Cache-Control": "no-store" });
    const send = () => { record.bytesWritten += chunk.length; record.chunks++; response.write(chunk); };
    send();
    const timer = setInterval(() => { send(); if (record.chunks === 20) { clearInterval(timer); response.end(); } }, 10);
    response.on("close", () => { clearInterval(timer); record.closed = true; });
    return;
  }
  if (url.pathname === "/") {
    response.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    response.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Neutral stream warmup check</title>
<body style="background:#080a13;color:white"><pre id="result">Running</pre><script>${helpers}
${extract(candidate)}
(async()=>{const response=await warmPlayableStream(location.origin+'/media.mp4?case=browser');
await new Promise(r=>setTimeout(r,300));const records=await(await fetch('/counters')).json();
const record=records.find(r=>r.name==='browser');window.warmupEvidence={status:response.status,...record,
passed:record.closed&&record.chunks<20&&record.range==='bytes=0-0'};
document.getElementById('result').textContent=JSON.stringify(window.warmupEvidence,null,2);})();</script></body></html>`);
    return;
  }
  response.writeHead(404); response.end();
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
origin = `http://127.0.0.1:${server.address().port}`;

if (process.argv.includes("--serve")) {
  console.log(`Neutral browser fixture: ${origin}/`);
} else {
  const results = { baseline: [], candidate: [] };
  try {
    for (let round = 0; round < 5; round++) {
      for (const [name, source] of [["baseline", baseline], ["candidate", candidate]]) {
        const sandbox = vm.createContext({ fetch, AbortController, URL, Date, Promise, Map,
          location: { origin, protocol: "http:" }, window: { setTimeout, clearTimeout } });
        vm.runInContext(`${helpers}\n${extract(source)}`, sandbox);
        const key = `${name}-${round}`;
        const start = performance.now();
        const response = await sandbox.warmPlayableStream(`${origin}/media.mp4?case=${key}`);
        const headersAndCleanupMs = performance.now() - start;
        assert.equal(response.status, 200);
        await sleep(500);
        const closedBeforeCleanup = records.get(key).closed;
        await response.body?.cancel().catch(() => {});
        const record = records.get(key);
        assert.equal(record.range, "bytes=0-0");
        results[name].push({ bytesWritten: record.bytesWritten, chunks: record.chunks, closedBeforeCleanup,
          headersAndCleanupMs: Number(headersAndCleanupMs.toFixed(2)) });
      }
    }
    assert.ok(results.baseline.every(row => row.chunks > 1));
    assert.ok(results.candidate.every((row, index) => row.closedBeforeCleanup && row.chunks < results.baseline[index].chunks));
    const total = name => results[name].reduce((sum, row) => sum + row.bytesWritten, 0);
    console.log(JSON.stringify({ base, scope: "Five local neutral ignored-Range pairs, capped at twenty 32-KiB chunks, observed for 500ms each",
      results, originBytesWrittenReductionPercent: 100 * (1 - total("candidate") / total("baseline")),
      limits: "Origin write counts are not measured billed wire bytes or real episode-startup timings. No production provider traffic." }, null, 2));
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
