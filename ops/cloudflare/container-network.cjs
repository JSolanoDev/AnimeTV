const dns = require("node:dns");
const { BlockList, isIP } = require("node:net");
// Cheerio's existing locked production dependency; no new dependency installation.
const { Agent, buildConnector, setGlobalDispatcher } = require("undici");
const deniedV4 = new BlockList();
for (const [address, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10],
  ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24],
  ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 3]]) deniedV4.addSubnet(address, prefix, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
const deniedV6 = new BlockList();
for (const [address, prefix] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16]]) {
  deniedV6.addSubnet(address, prefix, "ipv6");
}

function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) return !deniedV4.check(address, "ipv4");
  return family === 6 && globalV6.check(address, "ipv6") && !deniedV6.check(address, "ipv6");
}

function blocked() {
  return Object.assign(new Error("Container outbound access to non-public addresses is blocked"), { code: "ZENKAI_PRIVATE_ADDRESS" });
}

function createPublicConnector({ lookup = dns.lookup, connectorFactory = buildConnector } = {}) {
  const connect = connectorFactory({ lookup(hostname, options, callback) {
    lookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) return callback(error);
      if (!addresses?.length || addresses.some(({ address }) => !isPublicAddress(address))) return callback(blocked());
      // Return the checked DNS answer to the actual socket, preventing a second lookup/rebinding.
      if (options.all) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    });
  } });
  return (options, callback) => {
    const hostname = options.hostname.replace(/^\[|\]$/g, "");
    if (options.httpSocket || (isIP(hostname) && !isPublicAddress(hostname))) return callback(blocked());
    connect(options, callback);
  };
}

function installContainerNetworkPolicy() {
  setGlobalDispatcher(new Agent({ connect: createPublicConnector() }));
}

module.exports = { isPublicAddress, createPublicConnector, installContainerNetworkPolicy };
