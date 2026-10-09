import { createContainerGateway } from "./container-worker.mjs";
import { handleProductionGateway } from "./production-gateway.mjs";

export { ZenkaiBackend } from "./container-worker.mjs";
export default createContainerGateway("production-backend-v1", handleProductionGateway);
