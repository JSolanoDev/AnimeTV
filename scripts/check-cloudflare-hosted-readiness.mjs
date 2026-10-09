import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const HEALTH_URL = "https://zenkaitv-container-staging.juankisantiago.workers.dev/api/health";
const TRANSIENT_STATUS = new Set([404, 502, 503, 504]);

export async function waitForHostedStaging({ request = fetch, wait = sleep, now = () => performance.now(), healthUrl = HEALTH_URL,
  timeoutMs = 120000, delayMs = 15000, report = console.log } = {}) {
  if (![HEALTH_URL, "https://zenkaitv.juankisantiago.workers.dev/api/health"].includes(healthUrl)) throw new Error("Unapproved health URL");
  const started = now();
  const deadline = started + timeoutMs;
  let attempts = 0;
  while (now() < deadline && attempts < 8) {
    attempts++;
    let status = "network unavailable";
    try {
      const response = await request(healthUrl, { redirect: "manual", cache: "no-store",
        signal: AbortSignal.timeout(Math.max(1, Math.min(20000, Math.ceil(deadline - now())))) });
      status = response.status;
      if (response.status === 200) {
        const health = await response.json();
        if (health?.ok !== true || health.app !== "ZenkaiTV" || health.api !== "ready") {
          throw new Error("Hosted staging returned an unexpected health response");
        }
        return { attempts, readinessMs: Math.round(now() - started) };
      }
      await response.body?.cancel();
      if (!TRANSIENT_STATUS.has(response.status)) throw new Error("Hosted staging health HTTP " + response.status);
    } catch (error) {
      if (!(error instanceof TypeError) && !["AbortError", "TimeoutError"].includes(error.name)) throw error;
    }
    report("Staging propagation check " + attempts + ": " + status);
    const remaining = deadline - now();
    if (remaining <= 0 || attempts === 8) break;
    // Only probe our new health URL; never replay an episode or provider request.
    await wait(Math.min(delayMs, remaining));
  }
  throw new Error("Hosted staging did not become ready within the bounded propagation window");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== "production")) throw new Error("Choose staging or production health check");
  console.log(JSON.stringify(await waitForHostedStaging(process.argv[2] === "production"
    ? { healthUrl: "https://zenkaitv.juankisantiago.workers.dev/api/health" } : {})));
}
