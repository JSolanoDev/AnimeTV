(function () {
  "use strict";

  const copy = {
    en: { title: "Releases", calendar: "Release calendar", year: "Year", all: "All releases", available: "In library", upcoming: "Upcoming", released: "Released", months: "All months", search: "Search releases", empty: "No releases match your filters.", reset: "Clear filters", loading: "Loading releases...", error: "The release calendar could not be loaded.", retry: "Try again", updated: "Updated", count: "releases", episode: "Episode", prev: "Previous year", next: "Next year", details: "View episodes", announced: "Not in library yet" },
    es: { title: "Estrenos", calendar: "Calendario de estrenos", year: "A\u00f1o", all: "Todos", available: "En biblioteca", upcoming: "Pr\u00f3ximos", released: "Estrenado", months: "Todos los meses", search: "Buscar estrenos", empty: "No hay estrenos con estos filtros.", reset: "Limpiar filtros", loading: "Cargando estrenos...", error: "No se pudo cargar el calendario de estrenos.", retry: "Reintentar", updated: "Actualizado", count: "estrenos", episode: "Episodio", prev: "A\u00f1o anterior", next: "A\u00f1o siguiente", details: "Ver episodios", announced: "A\u00fan no est\u00e1 en biblioteca" }
  };
  const view = { year: new Date().getFullYear(), month: new Date().getMonth() + 1, filter: "all", query: "", data: null, loading: false, error: false, request: 0, loadedAt: 0, signature: "", controlsSignature: "", context: null, mounted: false };
  const icon = name => `<span class="release-icon release-icon-${name}" aria-hidden="true"></span>`;
  const text = () => copy[view.context?.language] || copy.en;
  const locale = () => view.context?.language === "es" ? "es" : "en";
  const esc = value => view.context.escape(String(value ?? ""));
  const monthName = (month, short = false) => new Intl.DateTimeFormat(locale(), { month: short ? "short" : "long", timeZone: "UTC" }).format(new Date(Date.UTC(2026, month - 1, 1)));
  const dateLabel = value => new Intl.DateTimeFormat(locale(), { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${value}T12:00:00Z`));
  function today() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  }
  function status(entry) {
    return entry.date > today() ? "upcoming" : entry.available ? "available" : "released";
  }
  function revealMonth() {
    const root = document.getElementById("releases");
    if (!root || root.classList.contains("is-hidden")) return;
    const strip = root.querySelector(".releases-months");
    const selected = strip?.querySelector('[aria-pressed="true"]');
    if (selected) strip.scrollLeft = selected.offsetLeft - strip.offsetLeft - (strip.clientWidth - selected.offsetWidth) / 2;
  }

  function mount(root) {
    root.innerHTML = `
      <header class="releases-heading">
        <div class="releases-heading-copy"><span class="releases-kicker"></span><h1></h1></div>
        <div class="releases-year-nav">
          <button class="release-icon-button focusable" type="button" data-release-year-step="-1">${icon("chevron-left")}</button>
          <select id="releaseYear" class="focusable"></select>
          <button class="release-icon-button focusable" type="button" data-release-year-step="1">${icon("chevron-right")}</button>
        </div>
      </header>
      <div class="releases-toolbar">
        <div class="releases-status-tabs" role="group"></div>
        <label class="releases-search">${icon("search")}<input id="releaseSearch" class="focusable" type="search" autocomplete="off"></label>
      </div>
      <nav class="releases-months"></nav>
      <div class="releases-summary"><p id="releaseCount" role="status" aria-live="polite" aria-atomic="true"></p><span id="releaseUpdated"></span></div>
      <div id="releaseResults"></div>`;
    root.addEventListener("click", event => {
      const month = event.target.closest("[data-release-month]");
      const filter = event.target.closest("[data-release-filter]");
      const step = event.target.closest("[data-release-year-step]");
      if (month) view.month = Number(month.dataset.releaseMonth);
      else if (filter) view.filter = filter.dataset.releaseFilter;
      else if (step) { changeYear(view.year + Number(step.dataset.releaseYearStep)); return; }
      else if (event.target.closest("[data-release-retry]")) { loadYear(); return; }
      else if (event.target.closest("[data-release-reset]")) {
        view.month = 0; view.filter = "all"; view.query = "";
        root.querySelector("#releaseSearch").value = "";
      } else return;
      paint();
    });
    root.querySelector("#releaseYear").addEventListener("change", event => changeYear(Number(event.target.value)));
    root.querySelector("#releaseSearch").addEventListener("input", event => { view.query = event.target.value; paint(); });
    view.mounted = true;
  }

  function changeYear(year) {
    if (!view.data?.years.includes(year) || year === view.year) return;
    view.year = year;
    view.month = year === new Date().getFullYear() ? new Date().getMonth() + 1 : 0;
    loadYear();
  }

  async function loadYear() {
    const request = ++view.request;
    view.loading = true;
    view.error = false;
    paint();
    try {
      const response = await fetch(`/api/adult/underhentai/releases?year=${view.year}`, { signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      if (!Array.isArray(payload.items) || !Array.isArray(payload.years) || payload.year !== view.year) throw new Error("Invalid calendar response");
      if (request !== view.request) return;
      view.data = payload;
      view.loadedAt = Date.now();
    } catch {
      if (request !== view.request) return;
      view.error = true;
    } finally {
      if (request === view.request) { view.loading = false; paint(); }
    }
  }

  function card(entry, index, shows) {
    const label = text();
    const show = shows.get(entry.catalogId);
    const state = status(entry);
    const canOpen = show && state === "available";
    const posterCandidates = [...new Set([
      entry.poster,
      ...(show && typeof view.context.posterCandidates === "function" ? view.context.posterCandidates(show) : []),
      show?.image
    ].map(value => String(value || "").trim()).filter(Boolean)
      .map(value => view.context.imageUrl(value, 480, 85)))];
    const poster = posterCandidates[0] || "";
    const fallbackData = posterCandidates.length > 1
      ? ` data-image-fallbacks="${esc(encodeURIComponent(JSON.stringify(posterCandidates)))}" data-image-fallback-index="0"`
      : "";
    const tag = canOpen ? "a" : "article";
    const target = canOpen ? `href="${esc(view.context.animePath(show))}/episode/s1-e${entry.episode}" data-open-show="${esc(show.id)}" data-open-season="1" data-open-episode="${entry.episode}" aria-label="${esc(entry.title)}, ${esc(label.episode)} ${entry.episode}, ${esc(label.details)}"` : "";
    return `<${tag} class="release-card${canOpen ? " focusable" : ""}" ${target}>
      <div class="release-poster" data-artwork-title="${esc(entry.title)}">
        ${poster ? `<img class="release-poster-img" src="${esc(poster)}"${fallbackData} alt="" width="259" height="370" loading="${index < 12 ? "eager" : "lazy"}" fetchpriority="${index < 6 ? "high" : "auto"}" decoding="async" referrerpolicy="no-referrer">` : ""}
        <span class="release-episode">${esc(label.episode)} ${String(entry.episode).padStart(2, "0")}</span>
        ${canOpen ? `<span class="release-open">${icon("arrow-up-right")}</span>` : ""}
      </div>
      <div class="release-card-copy"><div class="release-card-meta"><time datetime="${entry.date}">${esc(dateLabel(entry.date))}</time><span class="release-status is-${state}" title="${esc(state === "released" ? label.announced : label[state])}">${esc(label[state])}</span></div>
      <h3 title="${esc(entry.title)}">${esc(entry.title)}</h3></div>
    </${tag}>`;
  }

  function paint() {
    if (!view.context || !view.mounted) return;
    const root = document.getElementById("releases");
    const label = text();
    const entries = view.data?.year === view.year ? view.data.items : [];
    const years = view.data?.years || [view.year];
    const controlsSignature = JSON.stringify([locale(), years]);
    if (view.controlsSignature !== controlsSignature) {
      view.controlsSignature = controlsSignature;
      root.querySelector("h1").textContent = label.title;
      root.querySelector(".releases-kicker").textContent = label.calendar;
      const yearSelect = root.querySelector("#releaseYear");
      yearSelect.innerHTML = years.map(year => `<option value="${year}">${year}</option>`).join("");
      yearSelect.setAttribute("aria-label", label.year);
      const input = root.querySelector("#releaseSearch");
      input.placeholder = label.search;
      input.setAttribute("aria-label", label.search);
      root.querySelector(".releases-status-tabs").innerHTML = ["all", "available", "upcoming"].map(filter => `<button class="focusable" type="button" data-release-filter="${filter}">${esc(label[filter])}</button>`).join("");
      root.querySelector(".releases-status-tabs").setAttribute("aria-label", label.title);
      root.querySelector(".releases-months").setAttribute("aria-label", label.calendar);
      root.querySelector(".releases-months").innerHTML = [0, ...Array.from({ length: 12 }, (_, i) => i + 1)].map(month => `<button type="button" class="focusable" data-release-month="${month}" title="${esc(month ? monthName(month) : label.months)}">${esc(month ? monthName(month, true) : label.months)}<span></span></button>`).join("");
      requestAnimationFrame(revealMonth);
    }
    root.querySelector("#releaseYear").value = String(view.year);
    root.querySelectorAll("[data-release-year-step]").forEach(button => {
      const step = Number(button.dataset.releaseYearStep);
      button.disabled = !years.includes(view.year + step);
      button.title = step < 0 ? label.prev : label.next;
      button.setAttribute("aria-label", button.title);
    });
    root.querySelectorAll("[data-release-filter]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.releaseFilter === view.filter)));
    root.querySelectorAll("[data-release-month]").forEach(button => {
      const month = Number(button.dataset.releaseMonth);
      button.setAttribute("aria-pressed", String(month === view.month));
      const count = entries.filter(entry => !month || Number(entry.date.slice(5, 7)) === month).length;
      button.querySelector("span").textContent = count ? String(count) : "";
    });
    const result = root.querySelector("#releaseResults");
    result.setAttribute("aria-busy", String(view.loading));
    const filtered = entries.filter(entry => (!view.month || Number(entry.date.slice(5, 7)) === view.month)
      && (view.filter === "all" || status(entry) === view.filter)
      && entry.title.toLocaleLowerCase(locale()).includes(view.query.trim().toLocaleLowerCase(locale())));
    const shows = new Map(view.context.shows.map(show => [show.id, show]));
    const signature = JSON.stringify([view.year, view.month, view.filter, view.query, view.loading, view.error, view.loadedAt, locale(), today(), filtered.map(entry => [entry.id, shows.has(entry.catalogId)])]);
    if (view.signature === signature) return;
    view.signature = signature;
    root.querySelector("#releaseCount").textContent = view.loading ? label.loading : view.error ? "" : `${filtered.length} ${label.count} \u00b7 ${view.month ? monthName(view.month) + " " : ""}${view.year}`;
    root.querySelector("#releaseUpdated").textContent = view.data?.generatedAt && !view.error ? `${label.updated} ${new Intl.DateTimeFormat(locale(), { month: "short", day: "numeric" }).format(new Date(view.data.generatedAt))}` : "";
    if (view.loading) {
      result.innerHTML = `<div class="release-grid" aria-hidden="true">${Array.from({ length: 6 }, () => `<div class="release-skeleton"><div></div><span></span><span></span></div>`).join("")}</div>`;
    } else if (view.error) {
      result.innerHTML = `<div class="releases-empty"><p>${esc(label.error)}</p><button type="button" class="focusable" data-release-retry>${esc(label.retry)}</button></div>`;
    } else if (!filtered.length) {
      result.innerHTML = `<div class="releases-empty">${icon("calendar-days")}<p>${esc(label.empty)}</p><button type="button" class="focusable" data-release-reset>${esc(label.reset)}</button></div>`;
    } else {
      const months = [...new Set(filtered.map(entry => entry.date.slice(0, 7)))];
      let cardIndex = 0;
      result.innerHTML = months.map(month => {
        const rows = filtered.filter(entry => entry.date.startsWith(month));
        return `<section class="release-month-group"><div class="release-month-heading"><h2>${esc(monthName(Number(month.slice(5))))}</h2><span>${rows.length} ${esc(label.count)}</span></div><div class="release-grid">${rows.map(entry => card(entry, cardIndex++, shows)).join("")}</div></section>`;
      }).join("");
    }
    view.context.syncArtwork?.(result);
  }

  window.AdultReleases = {
    render(context) {
      view.context = context;
      const root = document.getElementById("releases");
      if (!root) return;
      if (!view.mounted) mount(root);
      if (!view.loading && !view.error && (!view.data || Date.now() - view.loadedAt > 6 * 60 * 60 * 1000)) loadYear();
      else paint();
    }
  };
  window.addEventListener("resize", () => requestAnimationFrame(revealMonth));
})();
