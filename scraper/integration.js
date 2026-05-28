/**
 * scraper/integration.js
 * ─────────────────────
 * Node.js helper that calls anime_scraper.py and returns the parsed catalog.
 *
 * Usage (from animetv-server.js or any other server file):
 *
 *   const { runScraper, readScrapedCatalog } = require('./scraper/integration');
 *
 *   // One-shot run (awaitable):
 *   const catalog = await runScraper();
 *   console.log(catalog.totalResults, 'items');
 *
 *   // Just read what's on disk (no Python call):
 *   const catalog = readScrapedCatalog();
 */

"use strict";

const { spawn }    = require("child_process");
const path         = require("path");
const fs           = require("fs");

const SCRAPER_DIR  = __dirname;
const SCRAPER_PY   = path.join(SCRAPER_DIR, "anime_scraper.py");
const OUTPUT_JSON  = path.join(SCRAPER_DIR, "anime_metadata.json");

/**
 * Run the Python scraper and resolve with the fresh catalog.
 *
 * @param {object}   [opts]
 * @param {string[]} [opts.sites]    Filter to specific sites, e.g. ["tioanime"]
 * @param {number}   [opts.timeout]  Max ms to wait for the process (default 5 min)
 * @returns {Promise<object>}        Parsed catalog JSON
 */
function runScraper({ sites = null, timeout = 5 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const args = [SCRAPER_PY];
    if (sites && sites.length > 0) {
      args.push("--sites", ...sites);
    }

    const proc = spawn("python", args, {
      cwd:   SCRAPER_DIR,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk) => {
      const line = chunk.toString();
      stdout += line;
      // Mirror scraper output to the server's console for visibility
      process.stdout.write(`[scraper] ${line}`);
    });

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    // Kill if it takes too long
    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error(`Scraper timed out after ${timeout / 1000}s`));
    }, timeout);

    proc.on("close", (code) => {
      clearTimeout(timer);

      if (code !== 0) {
        return reject(
          new Error(`Scraper exited with code ${code}.\n${stderr || stdout}`)
        );
      }

      try {
        resolve(readScrapedCatalog());
      } catch (readErr) {
        reject(readErr);
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      if (err.code === "ENOENT") {
        reject(
          new Error(
            "Python not found. Make sure Python 3.11+ is installed and on PATH.\n" +
            "  Windows: https://www.python.org/downloads/\n" +
            "  Then: pip install -r scraper/requirements.txt && scrapling install"
          )
        );
      } else {
        reject(err);
      }
    });
  });
}

/**
 * Read the last scraped catalog from disk without running the scraper.
 * Returns null if the file does not exist yet.
 *
 * @returns {object|null}
 */
function readScrapedCatalog() {
  if (!fs.existsSync(OUTPUT_JSON)) return null;
  const raw = fs.readFileSync(OUTPUT_JSON, "utf-8");
  return JSON.parse(raw);
}

/**
 * Return catalog metadata (totalResults, scrapedAt) without loading all items.
 */
function catalogMeta() {
  const catalog = readScrapedCatalog();
  if (!catalog) return null;
  return {
    ok:           catalog.ok,
    totalResults: catalog.totalResults,
    scrapedAt:    catalog.scrapedAt,
    source:       catalog.source,
  };
}

module.exports = { runScraper, readScrapedCatalog, catalogMeta };
