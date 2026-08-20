/**
 * Reserving a clone's name in the Aurixa zone.
 *
 * The decision is in `subdomainAllocation.pure.ts`; this is the I/O around it,
 * and the only interesting part is the retry.
 *
 * `clones_subdomain_uidx` is a unique partial index, so allocation is a
 * read-then-write with a gap in the middle. Two clones provisioned in the same
 * second can both read a taken-set that lacks the other's name, both pick it,
 * and the second UPDATE fails with 23505. That is not a fault to log — it is the
 * database doing exactly its job — so it is caught and re-allocated against a
 * freshly read set.
 *
 * One retry, not a loop: a second collision on a re-read set means something
 * other than a race, and spinning would turn a bug into an outage.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { allocateSubdomain } from "./subdomainAllocation.pure";
import { cloneFqdn } from "./dnsTarget.pure";

const admin = supabaseAdmin as any;

/** Postgres unique-violation. Anything else is a real error and is rethrown. */
const UNIQUE_VIOLATION = "23505";

export type ReserveResult =
  | { ok: true; subdomain: string; fqdn: string | null; suffixed: boolean; status: string }
  | { ok: false; reason: string };

async function takenSubdomains(excludeCloneId: string): Promise<string[]> {
  const { data } = await admin.from("clones").select("id, subdomain").not("subdomain", "is", null);
  return (data ?? [])
    .filter((r: { id: string }) => r.id !== excludeCloneId)
    .map((r: { subdomain: string }) => r.subdomain);
}

/**
 * Pick a name for a clone and write it onto the row.
 *
 * `subdomain_status` is set to `awaiting_deployment` rather than `queued`: the
 * name is reserved but nothing can be written into DNS until the clone's Vercel
 * project reports the CNAME it wants. Marking it `queued` here would promise a
 * job that does not exist, which is the state nobody can diagnose from the UI.
 */
export async function reserveCloneSubdomain(input: {
  cloneId: string;
  slug: string;
  preferred?: string | null;
}): Promise<ReserveResult> {
  const { data: cfg } = await admin
    .from("platform_hosting_config")
    .select("primary_domain, reserved_slugs")
    .eq("singleton", true)
    .maybeSingle();

  const reserved: string[] = cfg?.reserved_slugs ?? [];

  for (let attempt = 0; attempt < 2; attempt++) {
    const taken = await takenSubdomains(input.cloneId);
    const allocation = allocateSubdomain({
      slug: input.slug,
      preferred: input.preferred,
      taken,
      reserved,
    });
    if (!allocation.ok) return { ok: false, reason: allocation.reason };

    const fqdn = cloneFqdn(allocation.subdomain, cfg?.primary_domain);
    const { error } = await admin
      .from("clones")
      .update({
        subdomain: allocation.subdomain,
        subdomain_fqdn: fqdn,
        subdomain_status: "awaiting_deployment",
      })
      .eq("id", input.cloneId);

    if (!error) {
      return {
        ok: true,
        subdomain: allocation.subdomain,
        fqdn,
        suffixed: allocation.suffixed,
        status: "awaiting_deployment",
      };
    }
    // Lost the race. Re-read and pick again; anything else is a real failure.
    if (error.code !== UNIQUE_VIOLATION) return { ok: false, reason: error.message };
  }

  return { ok: false, reason: "collision_after_retry" };
}
