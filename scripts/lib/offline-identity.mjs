export function normalizeOfflineTitle(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’'`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function offlineIdentityKey(entry = {}) {
  if (entry.anilistId) return `anilist-${entry.anilistId}`;
  if (entry.malId) return `mal-${entry.malId}`;
  return "";
}

export function explicitOfflineSeasonNumber(entry = {}) {
  const numbers = [];
  for (const value of namesOf(entry)) {
    const title = normalizeOfflineTitle(value);
    let match = title.match(/\b(?:season|temporada)\s*(\d+)\b/);
    if (!match) match = title.match(/\b(\d+)(?:st|nd|rd|th)\s+season\b/);
    if (!match) match = title.match(/\bs\s*(\d+)\b/);
    if (match) numbers.push(Number(match[1]));
  }
  return numbers.length ? Math.max(...numbers) : null;
}

function namesOf(entry = {}) {
  return [entry.title, ...(entry.synonyms || [])].filter(Boolean);
}

function nameScore(left, right) {
  const a = normalizeOfflineTitle(left);
  const b = normalizeOfflineTitle(right);
  if (!a || !b) return 0;
  if (a === b || a.replace(/ /g, "") === b.replace(/ /g, "")) return 100;
  if (a.startsWith(b) || b.startsWith(a)) return 88;
  const aw = new Set(a.split(" "));
  const bw = new Set(b.split(" "));
  const common = [...aw].filter((word) => bw.has(word)).length;
  return Math.round((common / Math.max(aw.size, bw.size)) * 80);
}

function bestNameScore(title, entry) {
  return Math.max(0, ...namesOf(entry).map((name) => nameScore(title, name)));
}

function samePositiveNumber(left, right) {
  const a = Number(left);
  const b = Number(right);
  return Number.isFinite(a) && a > 0 && Number.isFinite(b) && b > 0 && a === b;
}

export function chooseExactIdentityRepair({ title, current = null, candidates = [] } = {}) {
  const exactTitle = normalizeOfflineTitle(title);
  const exact = candidates
    .filter((entry) => offlineIdentityKey(entry))
    .filter((entry) => namesOf(entry).some((name) => normalizeOfflineTitle(name) === exactTitle))
    .sort((a, b) => {
      const rank = (entry) =>
        (entry.anilistId ? 8 : 0)
        + (entry.malId ? 4 : 0)
        + (Number(entry.episodes) > 0 ? 2 : 0)
        + (entry.year ? 1 : 0);
      return rank(b) - rank(a);
    });
  const candidate = exact[0] || null;
  if (!candidate) return null;

  const currentKey = offlineIdentityKey(current || {});
  if (currentKey && currentKey === offlineIdentityKey(candidate)) return null;
  if (current && namesOf(current).some((name) => normalizeOfflineTitle(name) === exactTitle)) return null;

  // A sparse duplicate record is not an upgrade over a strongly matching,
  // fully identified entry. This covers aliases that different indexes spell
  // differently while retaining the same year and episode count.
  if (current) {
    const candidateEpisodes = Number(candidate.episodes);
    const currentEpisodes = Number(current.episodes);
    if ((!Number.isFinite(candidateEpisodes) || candidateEpisodes <= 0) && currentEpisodes > 0) return null;
    // Same-year, same-length records with meaningful title overlap are usually
    // two indexes naming the same one-off (for example an episode number plus a
    // subtitle versus the shorter provider title), not a season mismatch.
    const equivalentAlias = bestNameScore(title, current) >= 30
      && samePositiveNumber(candidate.episodes, current.episodes)
      && samePositiveNumber(candidate.year, current.year);
    if (equivalentAlias) return null;
  }

  return candidate;
}
