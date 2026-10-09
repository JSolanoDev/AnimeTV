const http = require("node:http");

process.env.ZENKAI_HOSTED_RUNTIME = "1";
require("./container-network.cjs").installContainerNetworkPolicy();
const handler = require("./animetv-server.js");
const server = http.createServer(handler);
server.listen(Number(process.env.PORT || 8080), process.env.HOST || "0.0.0.0", () => {
  console.log(`ZenkaiTV container API ready on port ${server.address().port}`);
});

// Match serverless behavior: no cold-start provider prewarming or catalog-update timers.
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => {
    server.closeAllConnections();
    process.exit(1);
  }, 30000);
  deadline.unref();
  server.close(() => { clearTimeout(deadline); process.exit(0); });
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
