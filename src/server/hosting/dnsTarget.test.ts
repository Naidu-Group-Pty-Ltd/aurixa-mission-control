import { describe, expect, it } from "vitest";
import { cloneFqdn, resolveCloneOrigin, resolveDnsTarget } from "./dnsTarget.pure";

const FLEET = { target_type: "a", target_value: "185.158.133.1", proxied: true };

describe("resolveDnsTarget", () => {
  it("prefers the target the deployment reported", () => {
    // The whole point: a fleet-wide record points every clone at an edge that
    // has never heard of it.
    const r = resolveDnsTarget(
      { dns_target_type: "cname", dns_target_value: "cname.vercel-dns.com" },
      FLEET,
    );
    expect(r).toEqual({
      recordType: "CNAME",
      recordContent: "cname.vercel-dns.com",
      source: "deployment",
      proxied: false,
    });
  });

  it("turns the deployment's record DNS-only", () => {
    // A proxied record terminates TLS at Cloudflare, so the provider's own
    // certificate challenge never reaches it and the domain never verifies.
    const r = resolveDnsTarget(
      { dns_target_type: "cname", dns_target_value: "cname.vercel-dns.com" },
      { ...FLEET, proxied: true },
    );
    expect(r?.proxied).toBe(false);
  });

  it("falls back to the fleet default, honouring its proxy flag", () => {
    const r = resolveDnsTarget(null, FLEET);
    expect(r).toEqual({
      recordType: "A",
      recordContent: "185.158.133.1",
      source: "fleet_default",
      proxied: true,
    });
  });

  it("falls back when the deployment has only half a target", () => {
    expect(resolveDnsTarget({ dns_target_type: "cname" }, FLEET)?.source).toBe("fleet_default");
    expect(resolveDnsTarget({ dns_target_value: "x.com" }, FLEET)?.source).toBe("fleet_default");
  });

  it("withdraws the fleet default entirely on a provider-managed fleet", () => {
    // Vercel routes by the domains registered on a project. A fleet-wide CNAME
    // for a domain no project has claimed answers DEPLOYMENT_NOT_FOUND, which
    // reads as a broken build and sends the debugging to the wrong place.
    const r = resolveDnsTarget(null, {
      target_type: "cname",
      target_value: "cname.vercel-dns.com",
      proxied: false,
      hosting_provider_slug: "vercel",
    });
    expect(r).toBeNull();
  });

  it("still honours the fleet default when a person configures the host", () => {
    // `manual` is the case the fleet default exists for, and withdrawing it
    // there would strand every hand-served clone.
    const r = resolveDnsTarget(null, { ...FLEET, hosting_provider_slug: "manual" });
    expect(r?.source).toBe("fleet_default");
  });

  it("does not let a provider-managed fleet suppress the deployment's own target", () => {
    // The withdrawal is of the FALLBACK. A deployment that reported a target is
    // the authority and must still win.
    const r = resolveDnsTarget(
      { dns_target_type: "cname", dns_target_value: "abc.vercel-dns.com" },
      { ...FLEET, hosting_provider_slug: "vercel" },
    );
    expect(r?.source).toBe("deployment");
    expect(r?.recordContent).toBe("abc.vercel-dns.com");
  });

  it("returns null rather than inventing a record", () => {
    // A record pointing somewhere wrong serves someone else's page; no record
    // serves NXDOMAIN. The second is the recoverable failure.
    expect(resolveDnsTarget(null, null)).toBeNull();
    expect(resolveDnsTarget(null, { target_type: "a", target_value: "  " })).toBeNull();
    expect(resolveDnsTarget({}, { target_type: "banana", target_value: "x" })).toBeNull();
  });
});

describe("resolveCloneOrigin", () => {
  it("uses the custom domain only once the deployment is live", () => {
    expect(
      resolveCloneOrigin({ domain: "acme.aurixasystems.com.au", deploymentStatus: "live" }),
    ).toBe("https://acme.aurixasystems.com.au");
  });

  it("will not claim a domain that has not verified", () => {
    // This is the guessed-origin failure: backend-provisioning constructs
    // `https://<slug>.aurixasystems.com.au` and writes it into an auth
    // allow-list for a host nothing serves.
    expect(
      resolveCloneOrigin({
        domain: "acme.aurixasystems.com.au",
        deploymentStatus: "attaching_domain",
      }),
    ).toBeNull();
  });

  it("falls back to the provider origin, which is reachable before DNS lands", () => {
    expect(
      resolveCloneOrigin({
        domain: "acme.aurixasystems.com.au",
        providerOrigin: "acme.vercel.app",
        deploymentStatus: "deploying",
      }),
    ).toBe("https://acme.vercel.app");
  });

  it("returns null for nothing, and for localhost", () => {
    expect(resolveCloneOrigin({})).toBeNull();
    expect(resolveCloneOrigin({ providerOrigin: "http://localhost:3000" })).toBeNull();
    expect(resolveCloneOrigin({ providerOrigin: "not a url at all" })).toBeNull();
  });
});

describe("cloneFqdn", () => {
  it("builds from the configured domain, never a hardcoded one", () => {
    expect(cloneFqdn("acme", "aurixasystems.com.au")).toBe("acme.aurixasystems.com.au");
    expect(cloneFqdn("ACME", ".example.com.")).toBe("acme.example.com");
  });

  it("is null when either half is missing", () => {
    expect(cloneFqdn(null, "example.com")).toBeNull();
    expect(cloneFqdn("acme", null)).toBeNull();
    expect(cloneFqdn("acme", "  ")).toBeNull();
  });
});
