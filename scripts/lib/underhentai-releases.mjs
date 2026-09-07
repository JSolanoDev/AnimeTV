import { load } from "cheerio";

const BASE = "https://www.underhentai.net";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function parseReleaseDate(text, year) {
  const match = String(text).match(/\b([A-Z][a-z]{2})\s+(\d{1,2}),\s+(\d{4})\b/);
  if (!match || Number(match[3]) !== year) return "";
  const month = MONTHS.indexOf(match[1]);
  if (month < 0) return "";
  const date = new Date(Date.UTC(year, month, Number(match[2])));
  return date.getUTCMonth() === month ? date.toISOString().slice(0, 10) : "";
}

export function parseReleases(html, year) {
  const $ = load(html);
  const entries = new Map();
  $("main article.post-card").each((_, element) => {
    const card = $(element);
    const title = card.find("h3").first().text().replace(/\s+/g, " ").trim();
    const badge = card.find(".badge").first().text().trim();
    const episode = Number(badge.match(/^EP\s+(\d+)$/i)?.[1]);
    const date = parseReleaseDate(card.find(".label-full").text(), year);
    if (!title || !episode || !date) return;
    try {
      // Announcements can have a trailer but no title page yet.
      const href = card.find("h3").closest("a[href]").attr("href");
      const link = href ? new URL(href, BASE) : null;
      if (link && (!["underhentai.net", "www.underhentai.net"].includes(link.hostname) || link.protocol !== "https:")) return;
      const slug = link ? link.pathname.match(/^\/([a-z0-9][a-z0-9_-]*)\/$/)?.[1]
        : title.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      if (!slug) return;
      const artwork = card.find("img").first().attr("src") || card.find("img").first().attr("data-src");
      const image = artwork ? new URL(artwork, BASE) : null;
      if (image) { image.search = ""; image.hash = ""; }
      const poster = image?.hostname === "static.underhentai.net" && image.protocol === "https:" ? image.href : "";
      const id = `${slug}-e${episode}-${date}`;
      entries.set(id, { id, slug, title, episode, date, poster });
    } catch { /* Ignore malformed or off-site advertisements. */ }
  });
  const years = new Set([year]);
  $("a[href]").each((_, link) => {
    const match = $(link).attr("href")?.match(/^\/releases\/(\d{4})\/$/);
    if (match) years.add(Number(match[1]));
  });
  return { entries: [...entries.values()].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id)), years: [...years].sort((a, b) => a - b) };
}

export function attachReleaseCatalog(entries, catalog, details) {
  const titles = new Map(catalog.map(item => [item.slug, item]));
  const episodes = new Map(details.map(item => [item.slug, new Set((item.episodes || []).filter(ep =>
    ep.videoUrl || ep.externalUrl || (ep.sourceOptions || []).some(source => source.videoUrl || source.watchUrl || source.embeds?.length || source.resolver)
  ).map(ep => Number(ep.number || ep.episode)))]));
  return entries.map(entry => {
    const title = titles.get(entry.slug);
    return {
      ...entry,
      poster: entry.poster || title?.poster || title?.image || "",
      catalogId: title ? `adult-underhentai-${entry.slug}` : "",
      available: Boolean(title && episodes.get(entry.slug)?.has(entry.episode))
    };
  });
}
