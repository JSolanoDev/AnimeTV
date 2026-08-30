/**
 * ZenkaiTV Adult Mode
 *
 * A single source of truth for the optional 18+ catalog mode. It owns:
 *   - the on/off state (+ "has the user confirmed 18+ once") with localStorage
 *     persistence so the choice survives a refresh,
 *   - a content classifier (`isAdultContent`) and a MUTUALLY-EXCLUSIVE catalog
 *     filter (`filterCatalog`) — adult mode shows ONLY adult content, default
 *     mode shows ONLY non-adult content; the two never mix in one view,
 *   - a tiny change-emitter so the UI (theme, header badge, rails) can react.
 *
 * It does NOT fetch anything. Adult content only appears once a real source is
 * wired through `AdultSourceAdapter` (see js/adult-source-adapter.js). Until
 * then, enabling adult mode simply yields an empty catalog (by design).
 */
const AdultMode = (function () {
  "use strict";

  const ENABLED_KEY = "zenkaitv:adult-mode:v1";
  const CONFIRMED_KEY = "zenkaitv:adult-mode-confirmed:v1";

  let _enabled = false;
  let _confirmed = false;
  const _listeners = new Set();

  // ── Persistence ─────────────────────────────────────────────────────────
  function load() {
    try {
      _enabled = localStorage.getItem(ENABLED_KEY) === "1";
      _confirmed = localStorage.getItem(CONFIRMED_KEY) === "1";
    } catch {
      _enabled = false;
      _confirmed = false;
    }
    _applyBodyClass();
    return _enabled;
  }

  function _persist() {
    try {
      localStorage.setItem(ENABLED_KEY, _enabled ? "1" : "0");
      localStorage.setItem(CONFIRMED_KEY, _confirmed ? "1" : "0");
    } catch { /* private mode / TV quota — runtime state still works */ }
  }

  function _applyBodyClass() {
    if (typeof document !== "undefined" && document.body) {
      document.body.classList.toggle("adult-mode", _enabled);
    }
  }

  // ── State accessors ─────────────────────────────────────────────────────
  function isEnabled() { return _enabled; }
  function hasConfirmedAge() { return _confirmed; }

  function onChange(fn) {
    if (typeof fn === "function") _listeners.add(fn);
    return () => _listeners.delete(fn);
  }

  function _emit() {
    _listeners.forEach((fn) => { try { fn(_enabled); } catch { /* listener errors are non-fatal */ } });
  }

  function _apply(on) {
    _enabled = Boolean(on);
    _applyBodyClass();
    _persist();
    _emit();
  }

  /**
   * Turn adult mode on/off. EVERY time it's switched on we require an explicit
   * 18+ confirmation: `confirmFn` is an async function returning a boolean (the
   * host app shows the modal). If it resolves false, nothing changes.
   */
  async function setEnabled(on, { confirmFn } = {}) {
    const next = Boolean(on);
    if (next === _enabled) return _enabled;
    if (next) {
      const ok = typeof confirmFn === "function" ? await confirmFn() : true;
      if (!ok) return _enabled;        // user declined — stay off
      _confirmed = true;
    }
    _apply(next);
    return _enabled;
  }

  async function toggle(opts) { return setEnabled(!_enabled, opts); }

  // ── Content classification ──────────────────────────────────────────────
  // A content item counts as adult if anything flags it as such. Adapters that
  // supply adult content should set `isAdult: true` (and/or `adultSource`) on
  // each item so this stays accurate without guessing.
  // ── Classifier regexes, compiled ONCE ──────────────────────────────────
  // These used to be built with new RegExp(...) inside a .some() on EVERY
  // call. filterCatalog() runs isAdultContent() for every show, and
  // catalogShows() is called from visibleShows()/renderSchedule()/favourites
  // (often several times per render), so a ~3,000-title catalog compiled
  // ~57,000 regexes per pass - the main source of route-switch lag.
  // Written as literals so the word-boundary escapes cannot be mangled.
  const _HENTAI_RE = /\bhentai\b/i;

  // Whole words: "anal" must not catch "analysis", "ntr" must not catch
  // "entry", "rape" must not catch "grape". Mainstream romance genres
  // (yuri/yaoi/girls love) are deliberately absent - regular anime.
  // Safety markers that also imply adult content (to separate catalogs).
    const _MINOR_MARKERS = [
      "child", "children", "elementary", "high school", "junior high",
      "loli", "lolicon", "middle school", "minor", "schoolboy", "schoolgirl",
      "shishunki", "shota", "shotacon", "student", "teen", "teenage",
      "underage", "young boy", "young girl", "joshi kousei", "joshi kōsei"
    ];

  const _ADULT_MARKER_RES = [
    /\banal\b/i,
    /\bbig boobs\b/i,
    /\bmilf\b/i,
    /\bcreampie\b/i,
    /\bincest\b/i,
    /\bnetorare\b/i,
    /\bntr\b/i,
    /\bblowjob\b/i,
    /\bfacial\b/i,
    /\bgangbang\b/i,
    /\btentacle\b/i,
    /\bbondage\b/i,
    /\bbdsm\b/i,
    /\bhandjob\b/i,
    /\bmasturbation\b/i,
    /\bpaizuri\b/i,
    /\brimjob\b/i,
    /\bbukkake\b/i,
    /\bahegao\b/i
  ];

  function isAdultContent(item) {
    if (!item) return false;
    if (item.isAdult === true || item.adult === true || item.nsfw === true || item.hentai === true) return true;
    if (item.adultSource) return true;
    const fields = [
      item.title,
      item.romajiTitle,
      item.nativeTitle,
      ...(Array.isArray(item.aliases) ? item.aliases : []),
      ...(Array.isArray(item.genres) ? item.genres : []),
      item.genre
    ].filter(Boolean).join(" ").toLowerCase().replace(/[_-]+/g, " ");

    if (_HENTAI_RE.test(fields)) return true;

    // Explicit hentai-only keywords for content that isn't tagged "Hentai".
    // IMPORTANT: matched as WHOLE WORDS (so "anal" can't catch "analysis",
    // "ntr" can't catch "entry", "rape" can't catch "grape"), and WITHOUT the
    // mainstream romance genres "yuri"/"yaoi"/"girls love" — those are regular
    // anime (e.g. "...Yoeru Sugata wa Yuri no Hana") and must stay in the normal
    // catalog. Real adult titles come in flagged via item.adultSource above.
    // Whole-word adult markers (compiled once - see _ADULT_MARKER_RES).
    if (_ADULT_MARKER_RES.some((re) => re.test(fields))) return true;

    // Safety markers that also imply adult content (to separate catalogs)
    // Safety markers (hoisted to _MINOR_MARKERS - see above).
    if (_MINOR_MARKERS.some((marker) => fields.includes(marker)) && (item.genre === "Hentai" || item.isAdult)) return true;

    return false;
  }

  function isSafeAdultContent(item) {
    // Permissive: everything identified as adult is "safe" for the user's requested adult mode.
    return isAdultContent(item);
  }

  /**
   * Mutually-exclusive catalog filter:
   *   - adult mode ON  → keep ONLY adult items
   *   - adult mode OFF → keep ONLY non-adult items
   * Use this on every content list (home rails, library, search, favorites,
   * continue watching) so the two catalogs never appear together.
   */
  function filterCatalog(items) {
    if (!Array.isArray(items)) return [];
    return _enabled
      ? items.filter(isAdultContent)
      : items.filter((item) => !isAdultContent(item));
  }

  // True when `item` belongs in the currently-active catalog.
  function matchesActiveCatalog(item) {
    return _enabled ? isSafeAdultContent(item) : !isAdultContent(item);
  }

  return {
    load,
    isEnabled,
    hasConfirmedAge,
    setEnabled,
    toggle,
    onChange,
    isAdultContent,
    isSafeAdultContent,
    matchesActiveCatalog,
    filterCatalog,
    ENABLED_KEY,
    CONFIRMED_KEY
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = AdultMode;
}
