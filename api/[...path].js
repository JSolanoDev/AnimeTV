try {
  require("sharp");
} catch {
  // Optional image optimization still falls back to passthrough locally.
}

try {
  require("../scraper/underhentai_catalog.json");
  require("../scraper/underhentai_details.json");
  require("../scraper/veohentai_catalog.json");
  require("../scraper/veohentai_details.json");
  require("../scraper/hentaila_catalog.json");
  require("../scraper/hentaila_details.json");
} catch {
  // Static bundler inclusion hint for Vercel NFT
}

const handleRequest = require("../animetv-server.js");

module.exports = function animeTvApi(request, response) {
  return handleRequest(request, response);
};
