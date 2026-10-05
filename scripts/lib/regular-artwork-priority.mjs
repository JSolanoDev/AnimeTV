import { execFileSync } from "node:child_process";

export function readPublishedArtworkIds(root) {
  try {
    const read = file => JSON.parse(execFileSync("git", ["show", `HEAD:scraper/${file}`], {
      cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"]
    }));
    return new Set([...Object.keys(read("artwork-map.json").entries || {}),
      ...(read("anime_metadata.json").items || []).map(item => item.id)]);
  } catch { return null; }
}

export function regularArtworkPriority(item, entries, publishedIds) {
  if (entries[item.id]?.status === "identity-repaired") return 3;
  if (publishedIds && !publishedIds.has(item.id)) return 2;
  return !entries[item.id]?.status ? 1 : 0;
}
