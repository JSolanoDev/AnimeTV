/**
 * ZenkaiTV Season Normalization System
 * 
 * Handles grouping anime entries into a logical hierarchy of Seasons, Parts, 
 * and Extras (Movies, OVAs, etc.) based on metadata and title parsing.
 */

const SeasonNormalization = (function() {
  'use strict';

  // Constants for grouping
  const TYPE_MAIN = 'main';
  const TYPE_SPECIAL = 'special';
  const TYPE_MOVIE = 'movie';
  const TYPE_RECAP = 'recap';

  /**
   * Main entry point: takes a list of related anime entries (from AniList franchise or similar)
   * and returns a normalized structure of groups.
   */
  function normalizeFranchise(entries) {
    if (!Array.isArray(entries) || !entries.length) return { groups: [] };

    // A "franchise" with a single entry has nothing to be an extra OF — it's
    // just that show's own episodes, regardless of its AniList format (ONA/OVA/
    // SPECIAL anime are often the only release for a title).
    const isStandalone = entries.length === 1;

    // AniList marks virtually every Chinese donghua and Korean aeni as ONA, so in a
    // franchise where nothing is TV or MOVIE, ONA IS the main format. Demoting it
    // filed the real first season under "OVAs / Specials": Link Click is eight ONA
    // entries, and its Season 1 (Shiguang Dailiren, 11 eps) landed there while the
    // picker showed Season 2, Season 3 and Season 5 with no Season 1 at all.
    const onaNative = !entries.some((entry) => {
      const f = String(entry.format || "").toUpperCase();
      return f === "TV" || f === "TV_SHORT" || f === "MOVIE";
    });
    // Shortest title in the franchise, used only in the ONA-native path below to
    // tell "the show itself" from "a spin-off of the show".
    const baseTitle = entries
      .map((entry) => String(entry.title?.romaji || entry.title?.english || entry.title || ""))
      .filter(Boolean)
      .sort((a, b) => a.length - b.length)[0] || "";

    // 1. Initial pass: parse each entry to get its identity
    const items = entries.map((entry) => parseEntryIdentity(entry, isStandalone, { onaNative, baseTitle })).sort((a, b) => {
      // Sort by air date / year primarily
      const dateA = a.yearStart || 9999;
      const dateB = b.yearStart || 9999;
      if (dateA !== dateB) return dateA - dateB;
      // Fallback to title order if same year
      return String(a.title).localeCompare(b.title);
    });

    const groups = [];
    let currentMainSeasonNumber = 1;

    // 2. Grouping pass
    items.forEach(item => {
      // Determine target group ID and label
      const { groupId, groupTitle, seasonNumber, partNumber, groupType } = determineGroup(item, groups, currentMainSeasonNumber, isStandalone);
      
      if (groupType === TYPE_MAIN && seasonNumber) {
        currentMainSeasonNumber = Math.max(currentMainSeasonNumber, seasonNumber);
      }

      let group = groups.find(g => g.id === groupId);
      if (!group) {
        group = {
          id: groupId,
          title: groupTitle,
          seasonNumber: seasonNumber,
          partNumber: partNumber,
          type: groupType,
          yearStart: item.yearStart,
          yearEnd: item.yearStart,
          episodeCount: 0,
          items: []
        };
        groups.push(group);
      }

      group.items.push(item);
      group.episodeCount += (item.episodeCount || 0);
      if (item.yearStart) {
        group.yearStart = group.yearStart ? Math.min(group.yearStart, item.yearStart) : item.yearStart;
        group.yearEnd = group.yearEnd ? Math.max(group.yearEnd, item.yearStart) : item.yearStart;
      }
    });

    // 2b. Relabel split seasons consistently. When a plain numbered season ends
    // up with several groups (a base cour + its "Part 2/3"), present them all as
    // "Season N Part 1/2/3" so the base cour isn't an unnumbered "Season N" next
    // to a "Season N Part 2". Only plain "Season N" labels are touched — Final
    // Season / arc / chapters titles are left exactly as they are.
    const seasonBuckets = new Map();
    groups.forEach((g) => {
      if (g.type !== TYPE_MAIN || !g.seasonNumber) return;
      const arr = seasonBuckets.get(g.seasonNumber) || [];
      arr.push(g);
      seasonBuckets.set(g.seasonNumber, arr);
    });
    seasonBuckets.forEach((arr, seasonNum) => {
      if (arr.length < 2) return;
      if (!arr.every((g) => /^Season \d+( Part \d+)?$/i.test(g.title))) return; // skip Final/arc labels
      arr.sort((a, b) => (a.partNumber || 1) - (b.partNumber || 1));
      arr.forEach((g, i) => {
        g.partNumber = i + 1;
        g.title = `Season ${seasonNum} Part ${i + 1}`;
        g.id = `season-${seasonNum}-part-${i + 1}`;
      });
    });

    // 3. Final polish: sort groups and ensure labels are clean
    return {
      groups: groups.sort((a, b) => {
        // Main seasons first, then movies, then specials
        const typeOrder = { [TYPE_MAIN]: 1, [TYPE_MOVIE]: 2, [TYPE_SPECIAL]: 3, [TYPE_RECAP]: 4 };
        const orderA = typeOrder[a.type] || 99;
        const orderB = typeOrder[b.type] || 99;
        if (orderA !== orderB) return orderA - orderB;
        
        if (a.type === TYPE_MAIN) {
          if (a.seasonNumber !== b.seasonNumber) return (a.seasonNumber || 0) - (b.seasonNumber || 0);
          return (a.partNumber || 0) - (b.partNumber || 0);
        }
        
        return (a.yearStart || 0) - (b.yearStart || 0);
      })
    };
  }

  /**
   * Parses an individual entry to extract identity markers.
   * `isStandalone` is true when this entry is the ONLY one in its franchise —
   * in that case it can't be "an extra" of anything, so it's always treated
   * as the show's main content regardless of AniList format (ONA/OVA/SPECIAL
   * formats are common for shows that only ever get a single release).
   */
  function parseEntryIdentity(entry, isStandalone = false, context = {}) {
    const { onaNative = false, baseTitle = "" } = context;
    const title = entry.title || entry.romajiTitle || entry.userPreferred || "";
    const format = String(entry.format || "").toUpperCase();

    // Extract metadata
    const yearStart = entry.seasonYear || entry.year || (entry.startDate ? entry.startDate.year : null);
    const episodeCount = entry.episodes || entry.totalEpisodes || (entry.episode && Number.isFinite(entry.episode) ? entry.episode : 0);

    // Title parsing
    const parsed = parseTitle(title);

    // Classification
    let type = TYPE_MAIN;
    if (!isStandalone) {
      if (format === 'MOVIE') type = TYPE_MOVIE;
      else if (parsed.isRecap || /\b(recap|summary|digest)\b/i.test(title)) type = TYPE_RECAP;
      else if (entry.mainline === false) {
        type = TYPE_SPECIAL;
        parsed.seasonNumber = null;
        parsed.partNumber = null;
      }
      else if (onaNative && format === 'ONA' && !parsed.isSpecial) {
        // ONA is this franchise's main format, so the format says nothing. Decide
        // from the title instead: the base title, alone or with a season marker, is
        // the show; anything carrying a further subtitle is a spin-off.
        // "Shiguang Dailiren" / "... II" -> seasons. "... : Xiao Juchang 2" -> a
        // shorts spin-off, which was being read as Season 2 off its trailing digit.
        if (isSpinOffOfBase(title, baseTitle)) {
          type = TYPE_SPECIAL;
          parsed.seasonNumber = null;
          parsed.partNumber = null;
        }
      }
      else if (format === 'SPECIAL' || format === 'OVA' || format === 'ONA' || parsed.isSpecial) {
        // If it has a season/part number, it might be main content (e.g. AoT Final Chapters)
        if (!parsed.seasonNumber && !parsed.partNumber && !parsed.isFinalSeason) {
          type = TYPE_SPECIAL;
        }
      }
    }

    return {
      ...entry,
      identityTitle: title,
      type,
      seasonNumber: parsed.seasonNumber,
      partNumber: parsed.partNumber,
      isFinalSeason: parsed.isFinalSeason,
      isFinalChapters: parsed.isFinalChapters,
      arcName: parsed.arcName,
      yearStart,
      episodeCount
    };
  }

  // Everything the title carries beyond the franchise's base name. An empty
  // remainder, or one that is purely a season marker, means this IS the show;
  // anything else is a spin-off. Only consulted for ONA-native franchises, so
  // arc-named seasons of TV shows ("Bleach: Sennen Kessen-hen") never reach it.
  function isSpinOffOfBase(title, baseTitle) {
    const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
    const t = norm(title);
    const b = norm(baseTitle);
    if (!b || t === b) return false;
    if (!t.startsWith(b + " ")) return false;   // unrelated title - leave it alone
    const rest = t.slice(b.length).trim();
    const SEASON_MARKER = /^(?:i{1,3}|iv|vi{0,3}|ix|x|\d{1,2}|season\s*\d+|\d+(?:st|nd|rd|th)\s*season|part\s*\d+|cour\s*\d+)$/;
    return !SEASON_MARKER.test(rest);
  }

  function parseTitle(title) {
    const t = String(title).toLowerCase().trim();
    
    const isFinalSeason = /\bfinal\s+season\b|\bthe\s+final\b/i.test(t);
    const isFinalChapters = /\bfinal\s+chapters\b|kanketsu/i.test(t);
    const isRecap = /\b(recap|summary|digest|総集編)\b/i.test(t);
    const isSpecial = /\b(ova|oav|special|extra|ona)\b/i.test(t);

    // Part / Cour parsing (parse this first so we know if trailing number is part-related)
    let partNumber = null;
    const pm = t.match(/\bpart\s*(\d+)\b/i) || t.match(/\bcour\s*(\d+)\b/i)
            || t.match(/\b(\d+)(?:st|nd|rd|th)\s+(?:part|cour)\b/i);
    if (pm) partNumber = parseInt(pm[1], 10);

    // Season parsing
    let seasonNumber = null;
    const sm = t.match(/\bseason\s*(\d+)\b/i) || t.match(/\b(\d+)(?:st|nd|rd|th)\s*season\b/i) || t.match(/第\s*(\d+)\s*[季期]/);
    if (sm) {
      seasonNumber = parseInt(sm[1], 10);
    } else if (/\b(second|2nd)\s+season\b/i.test(t)) {
      seasonNumber = 2;
    } else if (/\b(third|3rd)\s+season\b/i.test(t)) {
      seasonNumber = 3;
    } else if (/\b(fourth|4th)\s+season\b/i.test(t)) {
      seasonNumber = 4;
    } else if (/\b(fifth|5th)\s+season\b/i.test(t)) {
      seasonNumber = 5;
    } else if (/\b(sixth|6th)\s+season\b/i.test(t)) {
      seasonNumber = 6;
    } else {
      // Check trailing Roman numerals
      const romanMatch = t.match(/\b(ii|iii|iv|v|vi|vii|viii|ix|x)$/i);
      if (romanMatch) {
        const table = { ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };
        seasonNumber = table[romanMatch[1].toLowerCase()] || null;
      } else {
        // Check trailing bare numbers: must not be preceded by part/cour/ep/episode/v/vol/volume/movie/recap/special
        const trailingNumMatch = t.match(/\b(\d{1,2})$/);
        if (trailingNumMatch) {
          const num = parseInt(trailingNumMatch[1], 10);
          const context = t.substring(0, trailingNumMatch.index).trim();
          const isPartOrEp = /\b(part|cour|episode|ep|v|vol|volume|movie|recap|special)\s*$/i.test(context);
          if (!isPartOrEp) {
            seasonNumber = num;
          }
        }
      }
    }

    // Arc parsing
    let arcName = null;
    const arcMatches = [
      title.match(/:\s*([^:]+?)\s*Arc\b/i),
      title.match(/\b([^:]+?)\s+Arc\b/i),
      title.match(/-\s*([^:-]+?)\s*Arc\b/i),
      title.match(/\b(shibuya\s+incident|hashira\s+training|entertainment\s+district|mugen\s+train|swordsmith\s+village)\b/i)
    ];
    
    for (const m of arcMatches) {
      if (m) {
        arcName = (m[1] || m[0]).trim();
        // Capitalize first letter of each word
        arcName = arcName.split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
        break;
      }
    }

    return { seasonNumber, partNumber, isFinalSeason, isFinalChapters, isRecap, isSpecial, arcName };
  }

  function determineGroup(item, existingGroups, currentMaxSeason, isStandalone = false) {
    // 1. Movies, Specials, Recaps get their own broad groups if they don't have season markers
    if (item.type === TYPE_MOVIE && !item.seasonNumber) {
      return { groupId: 'movies', groupTitle: 'Movies', groupType: TYPE_MOVIE };
    }
    // A "Final Season" with no number in its title is, by definition, after every
    // numbered one. Large rather than Infinity so it survives arithmetic and JSON.
    const FINAL_SEASON_SORT = 9000;
    if (item.type === TYPE_RECAP) {
      return { groupId: 'recaps', groupTitle: 'Recaps / Summaries', groupType: TYPE_RECAP };
    }
    if (item.type === TYPE_SPECIAL && !item.seasonNumber && !item.isFinalChapters) {
      return { groupId: 'specials-ovas', groupTitle: 'OVAs / Specials', groupType: TYPE_SPECIAL };
    }

    // 2. Main content grouping
    let sNum = item.seasonNumber;
    let pNum = item.partNumber;
    let baseTitle = "";

    if (item.isFinalChapters) {
      // Sorts after every numbered season. It used to default to 4, which is only
      // right for Attack on Titan - the franchise this grouping was written
      // against. My Hero Academia's Final Season is the 8th, so a default of 4 put
      // it between Season 4 and Season 5 in the picker.
      sNum = sNum || FINAL_SEASON_SORT;
      baseTitle = "Final Season: Final Chapters";
      if (pNum) baseTitle += ` Part ${pNum}`;
      return { groupId: `final-chapters-${pNum || 1}`, groupTitle: baseTitle, seasonNumber: sNum, partNumber: pNum || 3, groupType: TYPE_MAIN };
    }

    if (item.isFinalSeason) {
      sNum = sNum || FINAL_SEASON_SORT;
      baseTitle = "Final Season";
      if (pNum) {
        return { groupId: `final-season-part-${pNum}`, groupTitle: `Final Season Part ${pNum}`, seasonNumber: sNum, partNumber: pNum, groupType: TYPE_MAIN };
      }
      return { groupId: 'final-season', groupTitle: 'Final Season', seasonNumber: sNum, partNumber: null, groupType: TYPE_MAIN };
    }

    if (sNum) {
      baseTitle = `Season ${sNum}`;
      if (pNum) {
        return { groupId: `season-${sNum}-part-${pNum}`, groupTitle: `Season ${sNum} Part ${pNum}`, seasonNumber: sNum, partNumber: pNum, groupType: TYPE_MAIN };
      }
      if (item.arcName) {
        return { groupId: `season-${sNum}-arc-${item.arcName.toLowerCase().replace(/\s+/g, '-')}`, groupTitle: `Season ${sNum}: ${item.arcName}`, seasonNumber: sNum, partNumber: null, groupType: TYPE_MAIN };
      }
      return { groupId: `season-${sNum}`, groupTitle: `Season ${sNum}`, seasonNumber: sNum, partNumber: null, groupType: TYPE_MAIN };
    }

    if (item.arcName) {
       return { groupId: `arc-${item.arcName.toLowerCase().replace(/\s+/g, '-')}`, groupTitle: `${item.arcName} Arc`, groupType: TYPE_MAIN };
    }

    // A bare "Part N" / "Cour N" (N >= 2) with NO explicit season number is the
    // next cour of the CURRENT season, not a brand-new season — e.g. Dr. STONE
    // "New World Part 2" or "Science Future Cour 2/3". Attaching it to the
    // current season keeps split-cour shows from inflating into Season 5/6/7.
    // (The base cour, which has no part number, created the current season just
    // before this; the relabel pass below renumbers them Part 1/2/3.)
    if (pNum && pNum >= 2 && existingGroups.some((g) => g.type === TYPE_MAIN)) {
      const baseSeason = currentMaxSeason || 1;
      return { groupId: `season-${baseSeason}-part-${pNum}`, groupTitle: `Season ${baseSeason} Part ${pNum}`, seasonNumber: baseSeason, partNumber: pNum, groupType: TYPE_MAIN };
    }

    // Fallback: If no markers but it's main type, it's likely Season 1 or the "Next" season
    // Check if it should be merged into the last main group if it aired very close? 
    // No, better to keep it as a new "Season" if it's a separate entry in AniList SEQUEL chain.
    
    // For a single-entry anime, we use "Episodes" or "Season 1"
    const isOnlyMain = !existingGroups.some(g => g.type === TYPE_MAIN);
    if (isOnlyMain) {
       if (isStandalone) {
         return { groupId: 'season-1', groupTitle: 'Episodes', seasonNumber: 1, groupType: TYPE_MAIN };
       }
       return { groupId: 'season-1', groupTitle: 'Season 1', seasonNumber: 1, groupType: TYPE_MAIN };
    }

    // Incremental fallback for SEQUELs that don't have a season number in title
    const nextSeason = currentMaxSeason + 1;
    return { groupId: `season-${nextSeason}`, groupTitle: `Season ${nextSeason}`, seasonNumber: nextSeason, groupType: TYPE_MAIN };
  }

  return {
    normalizeFranchise,
    parseTitle
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = SeasonNormalization;
}
