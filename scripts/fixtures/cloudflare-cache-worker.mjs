import { handleGateway } from "../../ops/cloudflare/gateway.mjs";

export default {
  fetch(request, env, ctx) {
    return handleGateway(request, { BACKEND_ORIGIN: "https://backend.example" }, ctx, {
      containerMedia: true,
      fetchImpl: async (url) => {
        const query = new URL(url).searchParams;
        const status = Number(query.get("status") || 200);
        const body = JSON.stringify({ ok: status === 200, configured: true, results: [{ id: 1 }], fixture: "neutral" });
        const headers = { "Content-Type": "application/json", "Content-Length": String(new TextEncoder().encode(body).byteLength),
          "Cache-Control": "public, max-age=120, s-maxage=600", ETag: '"neutral-v1"' };
        if (query.get("encoding") === "gzip") headers["Content-Encoding"] = "gzip";
        return new Response(body, { status, headers });
      }
    });
  }
};
