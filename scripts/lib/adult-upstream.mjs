export class AdultUpstreamUnavailableError extends Error {
  constructor(message, { status = null, retryAfter = null, cause } = {}) {
    super(message, { cause });
    this.name = "AdultUpstreamUnavailableError";
    this.code = "ADULT_UPSTREAM_UNAVAILABLE";
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export const isAdultUpstreamUnavailable = (error) => error?.code === "ADULT_UPSTREAM_UNAVAILABLE";

// A blocked refresh is retried by the next scheduled job, not by every worker.
export function createAdultFetcher({ headers, intervalMs = 550, timeoutMs = 20000,
  fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  let nextRequestAt = 0;
  let unavailable = null;
  function throwIfUnavailable() {
    if (unavailable) throw unavailable;
  }
  async function fetchText(url) {
    throwIfUnavailable();
    const scheduledAt = Math.max(Date.now(), nextRequestAt);
    nextRequestAt = scheduledAt + intervalMs;
    const delay = scheduledAt - Date.now();
    if (delay > 0) await sleep(delay);
    throwIfUnavailable();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { headers, redirect: "follow", signal: controller.signal });
      if (response.ok) return await response.text();
      await response.body?.cancel().catch(() => {});
      if ([403, 408, 429].includes(response.status) || response.status >= 500) {
        unavailable ||= new AdultUpstreamUnavailableError(`Adult provider HTTP ${response.status}`, {
          status: response.status, retryAfter: response.headers.get("retry-after")
        });
        throw unavailable;
      }
      throw new Error(`Adult provider HTTP ${response.status} ${response.statusText}`);
    } catch (error) {
      if (controller.signal.aborted || ["AbortError", "TimeoutError"].includes(error?.name)
        || (error instanceof TypeError && /fetch failed|network|terminated/i.test(error.message))) {
        unavailable ||= new AdultUpstreamUnavailableError("Adult provider network request failed or timed out", { cause: error });
        throw unavailable;
      }
      throw error;
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
  return { fetchText, throwIfUnavailable };
}
