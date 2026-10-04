import { requiresEmbedResolution } from "./source-probe-policy.mjs";

// Audit-only probes. Prefix reachability is not a browser playback certification.
export async function fetchBoundedAuditResponse(url, options = {}, timeoutMs = 12000, maxBytes = 512 * 1024) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let reader;
  try {
    const response = await fetch(url, { redirect: "follow", ...options, signal: controller.signal });
    reader = response.body?.getReader();
    const chunks = [];
    let size = 0;
    let complete = !reader;
    while (reader && size < maxBytes) {
      const { done, value } = await reader.read();
      if (done) { complete = true; break; }
      const chunk = value.subarray(0, maxBytes - size);
      chunks.push(chunk);
      size += chunk.length;
    }
    const bytes = Buffer.concat(chunks);
    return {
      ok: response.ok, status: response.status, headers: response.headers,
      url: response.url, bytes, complete,
      text: async () => bytes.toString("utf8"),
      json: async () => {
        if (!complete) throw new Error("Audit JSON exceeds the body limit");
        return JSON.parse(bytes.toString("utf8"));
      }
    };
  } finally {
    if (reader) reader.cancel().catch(() => {});
    clearTimeout(timer);
  }
}

export function isDownloadOnlyAuditSource(source = {}) {
  return /\bmega\b|mega\.nz|\bmediafire\b|mediafire\.com/i.test([
    source.provider, source.label, source.url, source.videoUrl, source.externalUrl
  ].filter(Boolean).join(" "));
}

export async function probeAuditMediaSource(source, { baseUrl, request, timeoutMs = 12000 }) {
  const failed = (failure, httpStatus = null, manifestType = "", detail = "") => ({
    usable: false, failure, httpStatus, manifestType, detail
  });
  if (isDownloadOnlyAuditSource(source)) return failed("DOWNLOAD_ONLY");
  let rawUrl = source.videoUrl || source.url || source.externalUrl || "";
  if (!rawUrl) return failed("NO_SOURCE");
  let referer = source.mediaReferer || source.referer || source.siteUrl || "";
  let type = source.container || source.type || "";
  const deadline = Date.now() + timeoutMs;
  const remaining = () => {
    const ms = deadline - Date.now();
    if (ms < 50) throw new Error("Audit media timeout");
    return ms;
  };
  const failureFor = status => status === 429 ? "SOURCE_RATE_LIMIT"
    : status === 403 ? "SOURCE_403" : status === 404 ? "SOURCE_404" : `SOURCE_HTTP_${status}`;
  const original = value => {
    const url = new URL(value, baseUrl);
    return /\/api\/(?:source|stream)$/.test(url.pathname) ? url.searchParams.get("url") || url.href : url.href;
  };
  const transport = value => {
    const url = new URL(value, baseUrl);
    if (url.origin === new URL(baseUrl).origin) return url.href;
    const proxy = new URL("/api/source", baseUrl);
    proxy.searchParams.set("url", url.href);
    if (referer) proxy.searchParams.set("refererHost", new URL(referer).hostname);
    return proxy.href;
  };
  try {
    if (requiresEmbedResolution(source)) {
      const resolver = new URL("/api/resolve", baseUrl);
      resolver.searchParams.set("url", rawUrl);
      if (referer) resolver.searchParams.set("referer", referer);
      const response = await request(resolver, {}, remaining());
      const resolved = await response.json().catch(() => null);
      if (!response.ok || !resolved?.ok || !resolved.url) return failed(response.ok ? "UNRESOLVED_EMBED" : failureFor(response.status), response.status, "embed");
      rawUrl = resolved.url;
      referer = resolved.mediaReferer || resolved.referer || referer;
      type = resolved.type || type;
    }
    const plausible = response => response.ok
      && !/html|json|text\/plain/i.test(response.headers.get("content-type") || "")
      && /video\/|audio\/|octet-stream|application\/mp4/i.test(response.headers.get("content-type") || "")
      && response.bytes.length >= 1024;
    const isHls = /hls|mpegurl/i.test(type + " " + (source.mimeType || ""))
      || /\.m3u8(?:$|[?#])|\/m3u8\//i.test(original(rawUrl));
    let mediaUrl = rawUrl;
    if (isHls) {
      for (let depth = 0; depth < 3; depth++) {
        const response = await request(transport(mediaUrl), {}, remaining());
        if (!response.ok) return failed(failureFor(response.status), response.status, "hls");
        if (!response.complete) return failed("MANIFEST_TOO_LARGE", response.status, "hls");
        const text = await response.text();
        if (!/^#EXTM3U/m.test(text)) return failed("BAD_MANIFEST", response.status, "hls");
        const references = text.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith("#"));
        if (!references.length) return failed("EMPTY_MANIFEST", response.status, "hls");
        const child = value => new URL(value, value.startsWith("/api/") ? baseUrl : original(mediaUrl)).href;
        if (/#EXT-X-STREAM-INF:/i.test(text)) { mediaUrl = child(references[0]); continue; }
        const fragments = [];
        for (const value of references.slice(0, 2)) {
          const fragment = await request(transport(child(value)), {}, remaining(), 64 * 1024);
          fragments.push({ status: fragment.status, bytes: fragment.bytes.length });
          if (!plausible(fragment)) return failed(fragment.ok ? "INVALID_MEDIA_BYTES" : failureFor(fragment.status), fragment.status, "hls");
        }
        return { usable: true, failure: "", httpStatus: response.status, manifestType: "hls", fragments, proof: "bounded-fragment-prefixes" };
      }
      return failed("NESTED_MANIFEST_LIMIT", null, "hls");
    }
    const ranges = [];
    for (const offset of [0, 1024 * 1024]) {
      const response = await request(transport(mediaUrl), { headers: { Range: `bytes=${offset}-${offset + 65535}` } }, remaining(), 64 * 1024);
      const rangeStart = response.headers.get("content-range")?.match(/^bytes\s+(\d+)-/i)?.[1];
      ranges.push({ status: response.status, bytes: response.bytes.length });
      if (!plausible(response)) return failed(response.ok ? "INVALID_MEDIA_BYTES" : failureFor(response.status), response.status, "file");
      if (offset && (response.status !== 206 || Number(rangeStart) !== offset)) return failed("RANGE_NOT_SUPPORTED", response.status, "file");
    }
    return { usable: true, failure: "", httpStatus: ranges[0].status, manifestType: "file", ranges, proof: "bounded-start-and-seek-ranges" };
  } catch (error) {
    return failed(/timeout|abort/i.test(error.message + error.name) ? "SOURCE_TIMEOUT" : "PROBE_ERROR", null, "", error.message);
  }
}
