import { describe, expect, it } from "vitest";
import {
  moduleProductShape,
  planModuleSync,
  type ModuleRow,
} from "@/server/stripe-module-sync.server";
import {
  MODULES,
  PURCHASABLE_MODULES,
  gstComponentCents,
  moduleBySlug,
} from "@/lib/pricing/aurixa-catalog";
import { TAX_CODE_SAAS } from "@/lib/pricing/tax-codes";

/** A catalog row as the price-list migration leaves it: priced, live, unlinked. */
const row = (slug: string, over: Partial<ModuleRow> = {}): ModuleRow => ({
  id: `id-${slug}`,
  slug,
  name: slug,
  price_min_cents: moduleBySlug(slug)?.monthlyInclGstCents ?? 0,
  is_active: true,
  stripe_price_id: null,
  stripe_product_id: null,
  ...over,
});

const allRows = () => MODULES.map((m) => row(m.slug));

describe("planModuleSync", () => {
  it("plans every purchasable module and no others", () => {
    const plan = planModuleSync(allRows());
    expect(plan.modules.map((m) => m.slug).sort()).toEqual(
      PURCHASABLE_MODULES.map((m) => m.slug).sort(),
    );
    expect(plan.warnings).toEqual([]);
    expect(plan.missing).toEqual([]);
  });

  it("never plans a roadmap module, and says which it skipped", () => {
    const plan = planModuleSync(allRows());
    const comingSoon = MODULES.filter((m) => m.comingSoon).map((m) => m.slug);

    // The guard that matters: Lenders is on the pricing page so the roadmap is
    // visible, and it has no price anyone agreed to pay. It must never reach
    // Stripe — and it must be REPORTED as skipped rather than quietly dropped,
    // or "18 of 23" reads as a bug.
    expect(comingSoon).toContain("lenders");
    expect(plan.skipped).toEqual(comingSoon);
    for (const slug of comingSoon) {
      expect(plan.modules.map((m) => m.slug)).not.toContain(slug);
    }
  });

  it("carries the sheet's tax-inclusive price, with GST derived not added", () => {
    const plan = planModuleSync(allRows());
    for (const op of plan.modules) {
      const mod = moduleBySlug(op.slug)!;
      expect(op.unitAmount).toBe(mod.monthlyInclGstCents);
      // The direction is the whole point: GST is CONTAINED in the amount
      // (÷11), never added to it. Getting this backwards overcharges every
      // customer by 10%.
      expect(op.gstComponent).toBe(gstComponentCents(op.unitAmount));
      expect(op.gstComponent).toBeLessThan(op.unitAmount);
      expect(op.unitAmount - op.gstComponent).toBeGreaterThan(0);
    }
  });

  it("pins the AML/CTF module to the gap between the tier headline prices", () => {
    // Not an arbitrary figure: 699−504, 1055−860 and 2210−2015 all equal 195,
    // and the pricing page states it in as many words. If this module's price
    // moves without the tiers moving, the two published figures stop
    // reconciling.
    const plan = planModuleSync(allRows());
    const aml = plan.modules.find((m) => m.slug === "aml-ctf");
    expect(aml?.unitAmount).toBe(19_500);
  });

  it("treats a row as live only when price and link agree", () => {
    const mod = PURCHASABLE_MODULES[0];
    const linked = planModuleSync([
      row(mod.slug, { stripe_price_id: "price_live", stripe_product_id: "prod_live" }),
    ]);
    expect(linked.modules[0].alreadyLive).toBe(true);

    // Linked, but the row is advertising something else — the exact drift
    // between "what the page shows" and "what Stripe charges" this sync exists
    // to prevent.
    const stale = planModuleSync([
      row(mod.slug, { stripe_price_id: "price_live", price_min_cents: 1 }),
    ]);
    expect(stale.modules[0].alreadyLive).toBe(false);

    // Priced correctly but nothing behind it: the state every row starts in.
    expect(planModuleSync([row(mod.slug)]).modules[0].alreadyLive).toBe(false);

    // Off sale entirely.
    expect(
      planModuleSync([row(mod.slug, { stripe_price_id: "price_live", is_active: false })])
        .modules[0].alreadyLive,
    ).toBe(false);
  });

  it("refuses to invent catalog rows the migration never created", () => {
    const plan = planModuleSync([]);
    expect(plan.modules).toEqual([]);
    expect(plan.missing).toEqual(PURCHASABLE_MODULES.map((m) => m.slug));
    expect(plan.warnings.join(" ")).toMatch(/price list migration/i);
  });
});

describe("moduleProductShape", () => {
  it("names the tiers that already bundle the module", () => {
    // The likeliest support question about a module charge is "isn't this
    // already in my plan?", so the answer belongs on the invoice line itself.
    const dealPipeline = moduleProductShape(moduleBySlug("deal-pipeline")!);
    expect(dealPipeline.name).toBe("Aurixa Deal Pipeline");
    expect(dealPipeline.description).toContain("Growth");
    expect(dealPipeline.description).toContain("Scale");
    expect(dealPipeline.metadata.included_in).toBe("growth,scale");
  });

  it("says so plainly when no tier bundles it", () => {
    const agent = moduleProductShape(moduleBySlug("aurixa-agent")!);
    expect(agent.description).toContain("every tier");
    // Empty rather than absent: an update must be able to CLEAR a stale list,
    // and Stripe distinguishes the two.
    expect(agent.metadata.included_in).toBe("");
  });

  it("reads as a list, not a chain of ands", () => {
    // Client Forms is on all three tiers; "Launch and Growth and Scale" is
    // what a naive join produces and it appears on customer invoices.
    expect(moduleProductShape(moduleBySlug("client-forms")!).description).toContain(
      "Launch, Growth and Scale",
    );
  });

  it("warns that AML/CTF is already inside every tier headline", () => {
    // The one description where being wrong costs money rather than time. The
    // module matrix says `includedIn: []`, but every tier's headline price
    // already contains it — it IS the $195 gap between each tier's two
    // published figures — so describing it as an ordinary add-on would invite
    // a customer to buy what they are already paying for.
    const aml = moduleProductShape(moduleBySlug("aml-ctf")!);
    expect(aml.description).toMatch(/already contained in every tier/i);
    expect(aml.description).not.toMatch(/available on every tier as an add-on/i);
  });

  it("keeps the module's own caveat", () => {
    const callLogs = moduleProductShape(moduleBySlug("call-logs")!);
    expect(callLogs.description).toContain("custom build price");
  });

  it("does not stutter the brand on modules that already carry it", () => {
    // These two are named "Aurixa Intelligence Hub" and "Aurixa Agent" in the
    // price list. A blanket prefix bills the customer for "Aurixa Aurixa
    // Agent".
    expect(moduleProductShape(moduleBySlug("intelligence-hub")!).name).toBe(
      "Aurixa Intelligence Hub",
    );
    expect(moduleProductShape(moduleBySlug("aurixa-agent")!).name).toBe("Aurixa Agent");
    for (const mod of PURCHASABLE_MODULES) {
      expect(moduleProductShape(mod).name).not.toMatch(/Aurixa Aurixa/);
      expect(moduleProductShape(mod).name.startsWith("Aurixa ")).toBe(true);
    }
  });

  it("tags every product with the slug the sync searches on", () => {
    for (const mod of PURCHASABLE_MODULES) {
      expect(moduleProductShape(mod).metadata.aurixa_module).toBe(mod.slug);
    }
  });
});

describe("moduleProductShape — tax code", () => {
  it("codes every module as SaaS rather than inheriting the account default", () => {
    // The account default is txcd_10000000, "General — Tangible Goods". A
    // product minted without a tax_code inherits it, which is how all 22 live
    // modules ended up taxed as physical goods. Domestically that is invisible
    // (10% GST either way); across a border it is the wrong tax on a legal
    // document.
    for (const slug of ["deal-pipeline", "aurixa-agent", "client-forms", "market-updates"]) {
      const mod = moduleBySlug(slug);
      if (!mod) continue;
      expect(moduleProductShape(mod).tax_code, slug).toBe(TAX_CODE_SAAS);
    }
  });

  it("never leaves tax_code unset", () => {
    // The failure mode is omission, not a wrong value — so assert presence.
    for (const mod of PURCHASABLE_MODULES) {
      const shape = moduleProductShape(mod);
      expect(shape.tax_code, mod.slug).toBeTruthy();
    }
  });
});
