export const STAGING_BRANCH = "cloudflare-staging/container-staging-2026-10-09";

export function validateStagingDeployment(config, env) {
  if (env.CI !== "true" || env.GITHUB_REPOSITORY !== "JSolanoDev/AnimeTV" ||
      env.GITHUB_REF !== "refs/heads/" + STAGING_BRANCH ||
      env.CLOUDFLARE_APPROVE_STAGING_DEPLOY !== "1" || !env.CLOUDFLARE_API_TOKEN) {
    throw new Error("Hosted staging deployment requires the approved repository, staging branch and CI credential.");
  }
  if (config.name !== "zenkaitv-container-staging" ||
      config.account_id !== "82846f471a6cc2b416851facadcd324b" ||
      config.main !== "ops/cloudflare/container-worker.mjs" ||
      config.routes !== undefined || config.route !== undefined || config.triggers !== undefined ||
      config.env !== undefined || config.vars !== undefined || config.workers_dev !== true ||
      config.containers?.length !== 1 || config.containers[0].name !== "zenkai-backend-staging" ||
      config.containers[0].max_instances !== 1 || config.containers[0].instance_type !== "basic" ||
      config.containers[0].image !== "./ops/cloudflare/Dockerfile" ||
      config.containers[0].image_build_context !== "./.cache/cloudflare-container-context") {
    throw new Error("Refusing deployment outside the isolated, single-container staging configuration.");
  }
}
