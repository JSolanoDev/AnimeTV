// Optional browser fixture: count origin requests behind the real service worker.
// Localhost only, neutral data, no providers, secrets or production cache changes.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const worker = readFileSync(new URL("../service-worker.js", import.meta.url));
const artwork = readFileSync(new URL("../logo-mark-128.webp", import.meta.url));
const counters = { source: 0, sourceBodyBytes: 0, healthyImage: 0, legacyImage: 0, partial: 0 };
const page = `<!doctype html><html lang="en"><meta charset="utf-8">
<title>Neutral service-worker network audit</title>
<body><h1>Service-Worker Network Audit</h1><pre id="result">Running</pre>
<script>
(async () => {
  await navigator.serviceWorker.register('/service-worker.js');
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) await new Promise(resolve =>
    navigator.serviceWorker.addEventListener('controllerchange', resolve, {once: true}));
  const sameSource = '/api/source?fixture=neutral';
  await (await fetch(sameSource)).json();
  await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', sameSource); xhr.onload = resolve; xhr.onerror = reject; xhr.send();
  });
  const images = await caches.open('zenkaitv-images-v1');
  async function storedImage(path) {
    for (let i = 0; i < 100; i++) {
      const cached = await images.match(path);
      if (cached?.status === 200) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Artwork cache write did not complete');
  }
  const healthy = '/api/image?src=neutral-healthy';
  await (await fetch(healthy)).arrayBuffer(); await storedImage(healthy);
  await (await fetch(healthy)).arrayBuffer();
  const legacy = '/api/image?src=neutral-empty';
  await images.put(legacy, new Response(null, {status: 204}));
  const recovery = await fetch(legacy); await recovery.arrayBuffer(); await storedImage(legacy);
  await (await fetch(legacy)).arrayBuffer();
  const external = 'EXTERNAL_ORIGIN/partial-neutral';
  const statuses = [];
  for (let i = 0; i < 2; i++) {
    const response = await fetch(external); statuses.push(response.status); await response.text();
  }
  const originCounts = await (await fetch('/counters')).json();
  const evidence = {controlled: !!navigator.serviceWorker.controller, originCounts,
    recoveredStatus: recovery.status, partialStatuses: statuses,
    partialCached: !!await images.match(external),
    passed: originCounts.source === 2 && originCounts.healthyImage === 1 &&
      originCounts.legacyImage === 1 && originCounts.partial === 2 && recovery.status === 200 &&
      statuses.every(status => status === 206) && !await images.match(external)};
  window.neutralNetworkEvidence = evidence;
  document.getElementById('result').textContent = JSON.stringify(evidence, null, 2);
})().catch(error => {
  window.neutralNetworkEvidence = {passed: false, error: error.message};
  document.getElementById('result').textContent = error.message;
});
</script></body></html>`;

const external = createServer((request, response) => {
  const url = new URL(request.url, "http://fixture.test");
  if (url.pathname !== "/partial-neutral") { response.writeHead(404); response.end(); return; }
  counters.partial++;
  response.writeHead(206, { "Content-Type": "text/plain", "Content-Range": "bytes 0-12/26",
    "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" });
  response.end("neutral-range");
});
await new Promise(resolve => external.listen(0, "127.0.0.1", resolve));
const externalOrigin = `http://127.0.0.1:${external.address().port}`;
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://fixture.test");
  response.setHeader("Cache-Control", "no-store");
  if (url.pathname === "/service-worker.js") {
    response.setHeader("Content-Type", "application/javascript"); response.end(worker);
  } else if (url.pathname === "/api/source") {
    counters.source++;
    const body = JSON.stringify({ ok: true, fixture: "neutral", sequence: counters.source });
    counters.sourceBodyBytes += Buffer.byteLength(body);
    response.setHeader("Content-Type", "application/json"); response.end(body);
  } else if (url.pathname === "/api/image") {
    if (url.searchParams.get("src") === "neutral-empty") counters.legacyImage++;
    else counters.healthyImage++;
    response.setHeader("Content-Type", "image/webp"); response.end(artwork);
  } else if (url.pathname === "/counters") {
    response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(counters));
  } else if (url.pathname === "/" || url.pathname === "/index.html") {
    response.setHeader("Content-Type", "text/html"); response.end(page.replace("EXTERNAL_ORIGIN", externalOrigin));
  } else if (url.pathname.endsWith(".js")) {
    response.setHeader("Content-Type", "application/javascript"); response.end("void 0;");
  } else if (url.pathname.endsWith(".css")) {
    response.setHeader("Content-Type", "text/css"); response.end("");
  } else if (url.pathname.endsWith(".webp")) {
    response.setHeader("Content-Type", "image/webp"); response.end(artwork);
  } else {
    response.setHeader("Content-Type", "text/html"); response.end("<!doctype html><title>Neutral fixture</title>");
  }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
console.log(JSON.stringify({ fixture: "service-worker-network", url: `http://127.0.0.1:${server.address().port}/` }));
function stop() { server.close(); external.close(); }
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
