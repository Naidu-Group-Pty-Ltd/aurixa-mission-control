/**
 * Multi-provider hosting abstraction.
 *
 * Deliberately the same shape as `src/server/edge/providers.ts`, which already
 * carries Cloudflare/AWS/Azure: a registry, a contract, and providers that
 * declare whether they are `live`. Two registries with two shapes is how the
 * two halves of "where does a clone live" drift apart.
 *
 * `manual` is a real member and not a placeholder. It is how every clone in this
 * fleet is served today — a Lovable custom-domain target behind one fleet-wide A
 * record — and modelling it as a provider is what lets `resolveDnsTarget` keep
 * behaving exactly as it does now for a clone nobody has migrated.
 */
import type { CloneEnvVar } from "./envPolicy.pure";

export type HostingProviderSlug = "vercel" | "manual";

export type CreateProjectInput = {
  cloneId: string;
  /** Project name on the provider. Must be stable for the life of the clone. */
  name: string;
  /** Repository to build from. */
  repo: { owner: string; name: string; defaultBranch: string };
  framework?: string | null;
  rootDirectory?: string | null;
};

export type ProjectResult = {
  projectId: string;
  projectName: string;
  teamId?: string | null;
  /** The provider's always-on origin, if it issues one at creation. */
  origin?: string | null;
  /** True when we adopted a project that already existed rather than creating one. */
  adopted: boolean;
  raw?: unknown;
};

export type DeployResult = {
  deploymentId: string;
  /** Origin for THIS deployment (usually a per-deployment URL). */
  url?: string | null;
  state: "queued" | "building" | "ready" | "error" | "canceled";
  raw?: unknown;
};

export type DomainVerificationChallenge = {
  type: string;
  domain: string;
  value: string;
  reason?: string | null;
};

export type DomainResult = {
  domain: string;
  verified: boolean;
  /** What DNS must say for this domain to resolve to this project. */
  dnsTargetType?: "A" | "CNAME" | null;
  dnsTargetValue?: string | null;
  challenges: DomainVerificationChallenge[];
  raw?: unknown;
};

export interface HostingProvider {
  slug: HostingProviderSlug;
  status: "live" | "manual" | "mocked";
  /** Whether the credentials this provider needs are present in the environment. */
  isConfigured(): boolean;

  createOrAdoptProject(input: CreateProjectInput): Promise<ProjectResult>;
  syncEnv(
    projectId: string,
    vars: CloneEnvVar[],
    teamId?: string | null,
  ): Promise<{ written: number; removed: number }>;
  deploy(projectId: string, opts: { ref: string; teamId?: string | null }): Promise<DeployResult>;
  getDeployment(deploymentId: string, teamId?: string | null): Promise<DeployResult>;
  attachDomain(projectId: string, domain: string, teamId?: string | null): Promise<DomainResult>;
  getDomain(projectId: string, domain: string, teamId?: string | null): Promise<DomainResult>;
  removeProject(projectId: string, teamId?: string | null): Promise<void>;
}

const registry = new Map<HostingProviderSlug, HostingProvider>();

export function registerHostingProvider(p: HostingProvider) {
  registry.set(p.slug, p);
}

export function getHostingProvider(slug: HostingProviderSlug): HostingProvider {
  const p = registry.get(slug);
  if (!p) throw new Error(`Hosting provider not registered: ${slug}`);
  return p;
}

export function listHostingProviders(): HostingProvider[] {
  return Array.from(registry.values());
}

/** Narrow an arbitrary string from the database to a slug we actually have. */
export function asHostingSlug(raw: string | null | undefined): HostingProviderSlug {
  return raw === "vercel" ? "vercel" : "manual";
}
