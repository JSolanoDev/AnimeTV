export const CATALOG_WORKFLOWS = new Set(["Scrape anime catalog", "Refresh Latest Release Artwork", "Refresh Adult Mode catalog"]);

export function validateProductionEvent(env, event) {
  if (env.CI !== "true" || env.GITHUB_REPOSITORY !== "JSolanoDev/AnimeTV" || env.GITHUB_REF !== "refs/heads/main") {
    throw new Error("Production requires the trusted main repository and CI runner");
  }
  if (!["push", "workflow_dispatch", "workflow_run"].includes(env.GITHUB_EVENT_NAME)) throw new Error("Untrusted deployment event");
  if (env.GITHUB_EVENT_NAME === "workflow_run") {
    const run = event?.workflow_run;
    if (run?.conclusion !== "success" || run.head_branch !== "main" || run.head_repository?.full_name !== env.GITHUB_REPOSITORY
      || !CATALOG_WORKFLOWS.has(run.name)) throw new Error("Untrusted catalog completion event");
  }
}

export function validateProductionDeployment(config, env, event) {
  validateProductionEvent(env, event);
  if (env.CLOUDFLARE_APPROVE_PRODUCTION_DEPLOY !== "1" || !env.CLOUDFLARE_API_TOKEN) throw new Error("Production requires explicit approval and a CI credential");
  if (config.name !== "zenkaitv" || config.account_id !== "82846f471a6cc2b416851facadcd324b"
    || config.main !== "ops/cloudflare/production-worker.mjs" || config.workers_dev !== true
    || ["routes", "route", "triggers", "env", "vars"].some((key) => config[key] !== undefined)
    || config.containers?.length !== 1 || config.containers[0].name !== "zenkai-backend-production"
    || config.containers[0].max_instances !== 1 || config.containers[0].instance_type !== "basic"
    || config.containers[0].scheduling_policy !== "default" || config.containers[0].class_name !== "ZenkaiBackend"
    || config.containers[0].image !== "./ops/cloudflare/Dockerfile"
    || config.containers[0].image_build_context !== "./.cache/cloudflare-container-context") {
    throw new Error("Refusing production deployment outside the capped, DNS-free configuration");
  }
}
