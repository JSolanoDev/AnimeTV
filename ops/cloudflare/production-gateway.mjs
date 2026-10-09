import { handleGateway } from "./gateway.mjs";

const HOSTS = new Set(["zenkaitv.com", "www.zenkaitv.com", "zenkaitv.juankisantiago.workers.dev"]);

export async function handleProductionGateway(request, env, ctx, options = {}) {
  const host = new URL(request.url).hostname;
  if (!HOSTS.has(host)) return new Response("Not found", { status: 404 });
  // Only this separately deployed entry point enables live domains, never request input.
  const response = await handleGateway(request, env, ctx, { ...options, production: true });
  if (host.endsWith(".workers.dev")) return response;
  const headers = new Headers(response.headers);
  headers.delete("x-robots-tag");
  return new Response(response.body, { status: response.status, statusText: response.statusText,
    headers, encodeBody: response.headers.get("x-zenkai-gateway-cache") === "HIT" ? "manual" : "automatic" });
}
