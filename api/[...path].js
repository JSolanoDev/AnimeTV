try {
  require("sharp");
} catch {
  // Optional image optimization still falls back to passthrough locally.
}

try {
  // resolve, NOT require: this is only here so Vercel NFT traces the files into
  // the bundle. require() would also PARSE them - about 11.7 MB of JSON on every
  // cold start - into objects nothing ever reads, because animetv-server.js opens
  // these same files with fs.readFileSync behind its own caches. vercel.json's
  // includeFiles already lists scraper/*.json, so they ship regardless.
  require.resolve("../scraper/underhentai_catalog.json");
  require.resolve("../scraper/underhentai_details.json");
  require.resolve("../scraper/veohentai_catalog.json");
  require.resolve("../scraper/veohentai_details.json");
  require.resolve("../scraper/hentaila_catalog.json");
  require.resolve("../scraper/hentaila_details.json");
} catch {
  // Static bundler inclusion hint for Vercel NFT
}

const handleRequest = require("../animetv-server.js");

module.exports = function animeTvApi(request, response) {
  return handleRequest(request, response);
};
