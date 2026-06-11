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
   * Turn adult mode on/off. The FIRST time it's switched on we require an
   * explicit 18+ confirmation: `confirmFn` is an async function returning a
   * boolean (the host app shows the modal). If it resolves false, nothing
   * changes. Once confirmed, the gate isn't shown again.
   */
  async function setEnabled(on, { confirmFn } = {}) {
    const next = Boolean(on);
    if (next === _enabled) return _enabled;
    if (next && !_confirmed) {
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
  function isAdultContent(item) {
    if (!item) return false;
    if (item.isAdult === true || item.adult === true || item.nsfw === true || item.hentai === true) return true;
    if (item.adultSource) return true;
    const genres = Array.isArray(item.genres) ? item.genres : (item.genre ? [item.genre] : []);
    if (genres.some((g) => /\bhentai\b/i.test(String(g)))) return true;
    return false;
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
    return _enabled ? isAdultContent(item) : !isAdultContent(item);
  }

  return {
    load,
    isEnabled,
    hasConfirmedAge,
    setEnabled,
    toggle,
    onChange,
    isAdultContent,
    matchesActiveCatalog,
    filterCatalog,
    ENABLED_KEY,
    CONFIRMED_KEY
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = AdultMode;
}
