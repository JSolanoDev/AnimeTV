import { prepareCloudflare } from "./prepare-cloudflare.mjs";
import { prepareContainerContext } from "./prepare-cloudflare-containers.mjs";

prepareCloudflare(undefined, undefined, { production: true });
console.log(`Prepared ${Object.keys(prepareContainerContext()).length} verified production backend inputs. No deployment performed.`);
