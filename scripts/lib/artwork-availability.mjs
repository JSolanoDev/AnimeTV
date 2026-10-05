export class ArtworkUpstreamUnavailableError extends Error {
  constructor(message, { status = null, retryAfter = null, cause } = {}) {
    super(message, { cause });
    this.name = "ArtworkUpstreamUnavailableError";
    this.code = "ARTWORK_UPSTREAM_UNAVAILABLE";
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export function createArtworkChecker({ hosts, known = new Set(), headers = {}, fetchImpl = globalThis.fetch,
  timeoutMs = 6000, intervalMs = 550, maxChecks = 500,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  unavailableError = (message, options) => new ArtworkUpstreamUnavailableError(message, options) }) {
  const stats = { checkedUrls: 0, rejectedUrls: 0 };
  const probes = new Map();
  let nextRequestAt = 0;
  let unavailable = null;

  function usable(value) {
    try {
      const url = new URL(String(value || ""));
      return url.protocol === "https:" && !url.username && !url.password && (!url.port || url.port === "443")
        && hosts.has(url.hostname.toLowerCase()) && !/\/themes\/|\/logo|\/no_image_p\.jpg$/i.test(url.pathname);
    } catch { return false; }
  }

  async function check(url) {
    if (!usable(url)) return false;
    if (known.has(url)) return true;
    if (probes.has(url)) return probes.get(url);
    if (stats.checkedUrls >= maxChecks) throw new Error("Artwork check budget exhausted; refusing partial publication.");
    stats.checkedUrls++;
    const pending = (async () => {
      if (unavailable) throw unavailable;
      const delay = Math.max(0, nextRequestAt - Date.now());
      nextRequestAt = Math.max(Date.now(), nextRequestAt) + intervalMs;
      if (delay) await sleep(delay);
      if (unavailable) throw unavailable;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        let target = url;
        let method = "HEAD";
        for (let hop = 0; hop < 4; hop++) {
          const response = await fetchImpl(target, { method, redirect: "manual", signal: controller.signal,
            headers: { Accept: "image/avif,image/webp,image/*", ...headers,
              ...(method === "GET" ? { Range: "bytes=0-0" } : {}) } });
          await response.body?.cancel().catch(() => {});
          if ([403, 408, 429].includes(response.status) || response.status >= 500) {
            unavailable = unavailableError(`Artwork provider HTTP ${response.status}`, {
              status: response.status, retryAfter: response.headers.get("retry-after")
            });
            throw unavailable;
          }
          if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get("location");
            if (!location) return false;
            target = new URL(location, target).href;
            if (!usable(target)) return false;
            continue;
          }
          // Unsupported HEAD gets one headers-only GET; never read image pixels.
          if (response.status === 405 && method === "HEAD") { method = "GET"; continue; }
          return response.ok && /^image\/(?:avif|webp|jpe?g|png|gif)(?:;|$)/i.test(response.headers.get("content-type") || "")
            && response.headers.get("content-length") !== "0";
        }
        return false;
      } catch (error) {
        if (controller.signal.aborted || error instanceof TypeError || ["AbortError", "TimeoutError"].includes(error.name)) {
          unavailable ||= unavailableError("Artwork request failed or timed out", { cause: error });
          throw unavailable;
        }
        throw error;
      } finally { clearTimeout(timer); controller.abort(); }
    })();
    probes.set(url, pending);
    const valid = await pending;
    if (!valid) stats.rejectedUrls++;
    return valid;
  }

  async function pick(values) {
    for (const value of new Set(values.filter(usable))) if (await check(value)) return value;
    return "";
  }
  return { usable, check, pick, stats };
}
