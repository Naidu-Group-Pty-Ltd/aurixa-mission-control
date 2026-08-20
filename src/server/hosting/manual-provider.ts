/**
 * The provider for a clone nobody has migrated.
 *
 * Every clone in this fleet is served this way today: a Lovable custom-domain
 * target behind one fleet-wide A record in `platform_hosting_config`. There is
 * no API to drive, and pretending otherwise would make `manual` a mock. It is
 * not a mock — it is a real hosting arrangement whose steps a person performs.
 *
 * Modelling it as a provider is what lets everything downstream keep exactly the
 * behaviour it has now: `resolveDnsTarget` falls back to the fleet default, the
 * subdomain worker writes the same record it writes today, and the clone is
 * reachable. What changes is only that the arrangement is now NAMED, so an
 * operator looking at a clone can tell "served manually" from "deployment
 * failed" — which is the distinction R4 exists for.
 *
 * Every method throws rather than resolving to a plausible empty value. A
 * silent no-op here would advance the state machine to `live` without anything
 * having been deployed, and write a `deploy_url` for a project that does not
 * exist — the confident-clear-against-nothing failure, in a new place.
 */
import type {
  CreateProjectInput,
  DeployResult,
  DomainResult,
  HostingProvider,
  ProjectResult,
} from "./providers";

function unsupported(op: string): never {
  throw new Error(
    `Hosting provider "manual" cannot ${op}: this clone is served by a manually configured ` +
      `target. Set a hosting provider on the clone to automate it.`,
  );
}

export const manualProvider: HostingProvider = {
  slug: "manual",
  status: "manual",

  // Always "configured": there is nothing to configure, and reporting it as
  // unconfigured would push every un-migrated clone into `pending_platform`,
  // which reads as "waiting for something" when nothing is being waited for.
  isConfigured: () => true,

  createOrAdoptProject(_input: CreateProjectInput): Promise<ProjectResult> {
    return unsupported("create a project");
  },
  syncEnv(): Promise<{ written: number; removed: number }> {
    return unsupported("sync environment variables");
  },
  deploy(): Promise<DeployResult> {
    return unsupported("trigger a deployment");
  },
  getDeployment(): Promise<DeployResult> {
    return unsupported("read a deployment");
  },
  attachDomain(): Promise<DomainResult> {
    return unsupported("attach a domain");
  },
  getDomain(): Promise<DomainResult> {
    return unsupported("read a domain");
  },
  removeProject(): Promise<void> {
    return unsupported("remove a project");
  },
};
