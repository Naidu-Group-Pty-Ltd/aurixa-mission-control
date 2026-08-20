/**
 * Where a clone's subdomain should point.
 *
 * `platform_hosting_config.target_value` is a single A record for the whole
 * fleet, documented as Lovable's `185.158.133.1`. That is correct for a platform
 * where ONE origin serves every clone and routes by `Host` header.
 *
 * It is wrong the moment each clone is its own hosting project. Vercel routes a
 * request by the domains registered on a project, so a fleet-wide CNAME points
 * every clone at an edge that has never heard of it and answers
 * `DEPLOYMENT_NOT_FOUND` — a page that looks like a broken deploy rather than
 * like misconfigured DNS, which is the expensive kind of wrong.
 *
 * So the target belongs to the DEPLOYMENT, and the platform value is the
 * fallback. This module is the only place that decides.
 *
 * On a PROVIDER-MANAGED fleet — which is what Aurixa now is, every clone staged
 * on Vercel and served at `<subdomain>.aurixasystems.com.au` — that fallback is
 * withdrawn entirely, and `resolveDnsTarget` returns null rather than writing a
 * record for a domain no project has claimed. The reasoning is in the function.
 */

export type DnsRecordType = "A" | "CNAME";

export type FleetDefault = {
  target_type: string | null | undefined; // 'a' | 'cname' in the column
  target_value: string | null | undefined;
  proxied?: boolean | null;
  /**
   * The platform's hosting provider. When a provider BUILDS and SERVES the
   * clone, the fleet default stops being a usable fallback — see
   * `resolveDnsTarget`.
   */
  hosting_provider_slug?: string | null;
};

/**
 * Providers that route by the domains registered on a project, so a fleet-wide
 * record cannot stand in for a per-deployment one.
 *
 * `manual` is deliberately absent: a hand-configured host is exactly the case
 * the fleet default exists for.
 */
const PROVIDER_MANAGED = new Set(["vercel"]);

export type DeploymentTarget = {
  dns_target_type?: string | null;
  dns_target_value?: string | null;
  status?: string | null;
};

export type ResolvedDnsTarget = {
  recordType: DnsRecordType;
  recordContent: string;
  /** Where the value came from — rendered to the operator, never inferred. */
  source: "deployment" | "fleet_default";
  /**
   * Whether Cloudflare should proxy the record.
   *
   * A proxied (orange-cloud) record terminates TLS at Cloudflare and hides the
   * origin — which is what breaks a hosting provider's own certificate
   * provisioning, because the provider's ACME challenge never reaches it. When
   * the target came from the deployment we therefore default to DNS-only, and
   * only the fleet default honours the configured `proxied` flag.
   */
  proxied: boolean;
};

function normaliseType(raw: string | null | undefined): DnsRecordType | null {
  if (!raw) return null;
  const t = raw.trim().toUpperCase();
  if (t === "A" || t === "AAAA") return "A";
  if (t === "CNAME") return "CNAME";
  return null;
}

/**
 * Resolve the record to write for one clone.
 *
 * Returns null when there is nothing to write — an unconfigured platform and a
 * deployment that has not reported a target yet are both "not yet", and
 * inventing a record for either is how a subdomain comes to resolve somewhere
 * wrong. A record pointing at the wrong place is worse than no record: the
 * first serves somebody else's page, the second serves NXDOMAIN.
 */
export function resolveDnsTarget(
  deployment: DeploymentTarget | null | undefined,
  fleet: FleetDefault | null | undefined,
): ResolvedDnsTarget | null {
  const deployType = normaliseType(deployment?.dns_target_type);
  const deployValue = deployment?.dns_target_value?.trim();
  if (deployType && deployValue) {
    return {
      recordType: deployType,
      recordContent: deployValue,
      source: "deployment",
      proxied: false,
    };
  }

  // On a provider-managed fleet the default is NOT a fallback.
  //
  // Every clone is its own Vercel project and Vercel routes by the domains
  // registered on one, so `cname.vercel-dns.com` for a domain no project has
  // claimed resolves to an edge that answers DEPLOYMENT_NOT_FOUND. That is a
  // page which looks like a broken deploy rather than like absent DNS, and it
  // sends whoever debugs it to the build logs instead of to the domain.
  //
  // NXDOMAIN is the better failure: it is unambiguous, it is what "this clone
  // has no deployment yet" actually means, and it costs nothing to correct the
  // moment the deployment reports its target.
  const providerManaged = PROVIDER_MANAGED.has((fleet?.hosting_provider_slug ?? "").toLowerCase());
  if (providerManaged) return null;

  const fleetType = normaliseType(fleet?.target_type);
  const fleetValue = fleet?.target_value?.trim();
  if (fleetType && fleetValue) {
    return {
      recordType: fleetType,
      recordContent: fleetValue,
      source: "fleet_default",
      proxied: fleet?.proxied ?? true,
    };
  }

  return null;
}

/**
 * The origin a clone is reachable at, in preference order, or null.
 *
 * `null` is a real answer and the important one. `backend-provisioning` builds a
 * new Supabase project's `site_url` and `uri_allow_list` from
 * `deploy_url ?? lovable_project_url` — two columns nothing writes — and then
 * falls through to a hostname CONSTRUCTED from the slug. A guessed origin is
 * worse than none: it produced an auth allow-list for a host nothing served, and
 * because a redirect allow-list fails at sign-in rather than at write time,
 * nothing reported it.
 */
export function resolveCloneOrigin(input: {
  /** The verified custom domain, if the deployment reached `live`. */
  domain?: string | null;
  /** The provider's always-on origin, e.g. https://project.vercel.app */
  providerOrigin?: string | null;
  deploymentStatus?: string | null;
}): string | null {
  if (input.deploymentStatus === "live" && input.domain?.trim()) {
    return `https://${input.domain
      .trim()
      .replace(/^https?:\/\//, "")
      .replace(/\/+$/, "")}`;
  }
  const origin = input.providerOrigin?.trim();
  if (!origin) return null;
  const withScheme = /^https?:\/\//i.test(origin) ? origin : `https://${origin}`;
  try {
    const u = new URL(withScheme);
    if (!u.hostname || u.hostname === "localhost") return null;
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

/** `slug` + the platform's primary domain. Never hardcode the domain. */
export function cloneFqdn(
  slug: string | null | undefined,
  primaryDomain: string | null | undefined,
): string | null {
  const s = slug?.trim().toLowerCase();
  const d = primaryDomain
    ?.trim()
    .toLowerCase()
    .replace(/^\.+|\.+$/g, "");
  if (!s || !d) return null;
  return `${s}.${d}`;
}
