// Stop network work before Actions kills the step, leaving time to save its map.
export function createEnrichmentBudget(args, defaultMinutes, { now = Date.now, request = globalThis.fetch } = {}) {
  const index = args.indexOf("--max-minutes");
  const minutes = index < 0 ? defaultMinutes : Number(args[index + 1]);
  if (!Number.isFinite(minutes) || minutes <= 0) throw new Error("--max-minutes must be positive");
  const deadline = now() + minutes * 60_000;
  const remaining = () => Math.max(0, deadline - now());
  return {
    expired: () => remaining() === 0,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, remaining()))),
    fetch: (url, options = {}) => {
      if (!remaining()) throw new Error("Enrichment time budget exhausted");
      const timeout = AbortSignal.timeout(Math.max(1, Math.ceil(Math.min(20_000, remaining()))));
      return request(url, { ...options, signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout });
    }
  };
}
