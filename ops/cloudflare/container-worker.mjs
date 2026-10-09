import { DurableObject } from "cloudflare:workers";
import { handleGateway } from "./gateway.mjs";
import { ContainerBackend, INTERNAL_ORIGIN, INACTIVITY_TIMEOUT_MS } from "./container-runtime.mjs";

export class ZenkaiBackend extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.backend = new ContainerBackend(ctx.container, env);
    if (ctx.container?.running) {
      void ctx.blockConcurrencyWhile(() => ctx.container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS));
    }
  }

  fetch(request) {
    const response = this.backend.fetch(request);
    // Only the bounded startup probe outlives a cancelled creator, not an idle monitor loop.
    if (this.backend.startup) this.ctx.waitUntil(this.backend.startup.catch(() => {}));
    return response;
  }
}

export function createContainerGateway(instanceName, gateway = handleGateway) {
  return {
  fetch(request, env, ctx) {
    return gateway(request, { ...env, BACKEND_ORIGIN: INTERNAL_ORIGIN }, ctx, {
      containerMedia: true,
      fetchImpl: (url, options) => {
        // The fixed instance name and binding prevent client-controlled container creation or origins.
        const stub = env.BACKEND.getByName(instanceName);
        return stub.fetch(new Request(url, options));
      }
    });
  }
  };
}

export default createContainerGateway("staging-backend-v1");
