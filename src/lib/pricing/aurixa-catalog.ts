// The Aurixa price list, as decided — one source of truth for all three repos.
//
// Transcribed from the signed-off pricing sheet (Aurixa_Pricing_Tier_1.xlsx).
// Every figure in that sheet is headed "Incl GST", and that is how they are
// stored here: these are the amounts a customer actually pays. GST is derived
// FROM them (÷11), never added to them. Getting that backwards overcharges
// every customer by 10%, so the direction is asserted in the tests.
//
// Tiers are priced WITHOUT the AML/CTF module, because the sheet's own numbers
// say that is what they are: 699−504, 1055−860 and 2210−2015 all equal exactly
// 195, which is the listed price of the AML/CTF module. So a tier is
// `base + optional $195 module` rather than two separate products, and the
// "with AML/CTF" headline prices fall out of the arithmetic instead of being
// a second set of figures to keep in step.

/** Australian GST is 10%, so a tax-inclusive total is 11/10 of its base. */
export const GST_DIVISOR = 11;

/** Annual plans bill 12 months at a 10% discount. */
export const ANNUAL_DISCOUNT = 0.1;

/** The GST contained within a tax-inclusive amount. */
export function gstComponentCents(inclGstCents: number): number {
  return Math.round(inclGstCents / GST_DIVISOR);
}

/** The ex-GST (net) amount of a tax-inclusive total. */
export function exGstCents(inclGstCents: number): number {
  return inclGstCents - gstComponentCents(inclGstCents);
}

/**
 * The annual charge for a monthly tax-inclusive price: twelve months less 10%.
 * Still tax-inclusive — the discount is applied to the total the customer pays.
 */
export function annualCents(monthlyInclGstCents: number): number {
  return Math.round(monthlyInclGstCents * 12 * (1 - ANNUAL_DISCOUNT));
}

/** What an annual plan works out to per month, for "$X/mo billed annually". */
export function annualPerMonthCents(monthlyInclGstCents: number): number {
  return Math.round(annualCents(monthlyInclGstCents) / 12);
}

export type BillingPeriod = "monthly" | "annual";

export type Tier = {
  slug: string;
  name: string;
  /** Row this replaces in the existing catalog, or null to keep its own. */
  replacesSlug: string | null;
  seatMin: number;
  seatMax: number;
  /** Monthly, tax-inclusive, WITHOUT the AML/CTF module. */
  monthlyInclGstCents: number;
  blurb: string;
};

/**
 * The three tiers from the sheet.
 *
 * `replacesSlug` records the decision to reuse existing catalog rows rather
 * than mint new ones: the old Professional row becomes Growth and the old
 * Growth row becomes Scale, so Stripe products and subscription history stay
 * attached to a row instead of being orphaned. Enterprise is untouched and
 * stays on sale.
 */
export const TIERS: readonly Tier[] = [
  {
    slug: "launch",
    name: "Launch",
    replacesSlug: "launch",
    seatMin: 1,
    seatMax: 4,
    monthlyInclGstCents: 50400,
    blurb: "For a solo adviser or a small team getting started.",
  },
  {
    slug: "growth",
    name: "Growth",
    replacesSlug: "professional",
    seatMin: 5,
    seatMax: 15,
    monthlyInclGstCents: 86000,
    blurb: "For a growing practice running comparisons and a deal pipeline.",
  },
  {
    slug: "scale",
    name: "Scale",
    replacesSlug: "growth",
    seatMin: 16,
    seatMax: 30,
    monthlyInclGstCents: 201500,
    blurb: "The full platform, with finance, marketing and agreements.",
  },
];

export type ModuleCategory =
  | "Main Dashboard"
  | "Reports & Analysis"
  | "Client & CRM"
  | "Operations"
  | "AML / CTF Compliance"
  | "Administration"
  | "AI Assistant";

export type PricedModule = {
  slug: string;
  name: string;
  category: ModuleCategory;
  /** Monthly, tax-inclusive. */
  monthlyInclGstCents: number;
  /** Tier slugs that include this module at no extra cost. */
  includedIn: readonly string[];
  /** Not yet purchasable — listed so the roadmap is visible. */
  comingSoon?: boolean;
  note?: string;
};

/**
 * The add-on modules, with the sheet's tax-inclusive prices.
 *
 * `includedIn` is derived from the sheet's own tier matrix, and the two agree
 * everywhere: each "Activated under X pricing" note names the module that the
 * tier introducing that capability unlocks. Deal Pipeline and Market Updates
 * arrive with Growth; Agreements, Marketing, Model Hub, Finance Portal, API
 * Usage, Commercial/Industrial and Opportunity Marketplace arrive with Scale.
 */
export const MODULES: readonly PricedModule[] = [
  // Main Dashboard
  {
    slug: "market-updates",
    name: "Market Updates",
    category: "Main Dashboard",
    monthlyInclGstCents: 5900,
    includedIn: ["growth", "scale"],
  },
  {
    slug: "commercial-industrial",
    name: "Commercial / Industrial",
    category: "Main Dashboard",
    monthlyInclGstCents: 16900,
    includedIn: ["scale"],
  },
  {
    slug: "opportunity-marketplace",
    name: "Opportunity Marketplace",
    category: "Main Dashboard",
    monthlyInclGstCents: 16900,
    includedIn: ["scale"],
  },

  // Reports & Analysis
  {
    slug: "intelligence-hub",
    name: "Aurixa Intelligence Hub",
    category: "Reports & Analysis",
    monthlyInclGstCents: 7900,
    includedIn: [],
  },
  {
    slug: "report-comparisons",
    name: "Generated Reports — Comparisons",
    category: "Reports & Analysis",
    monthlyInclGstCents: 9900,
    includedIn: ["growth", "scale"],
  },
  {
    slug: "cashflow-comparisons",
    name: "Cash Flow Analysis — Comparisons",
    category: "Reports & Analysis",
    monthlyInclGstCents: 9900,
    includedIn: ["growth", "scale"],
  },

  // Client & CRM
  {
    slug: "email-copilot",
    name: "Email Copilot",
    category: "Client & CRM",
    monthlyInclGstCents: 9900,
    includedIn: [],
    note: "Unlocks client Emails, which stay off on every tier without it.",
  },
  {
    slug: "call-logs",
    name: "Call Logs",
    category: "Client & CRM",
    monthlyInclGstCents: 22500,
    includedIn: [],
    note: "Plus a custom build price if requested.",
  },
  {
    slug: "portfolio-analysis",
    name: "Portfolio Analysis",
    category: "Client & CRM",
    monthlyInclGstCents: 12500,
    includedIn: ["scale"],
  },
  {
    slug: "send-portfolio",
    name: "Send Portfolio To Client",
    category: "Client & CRM",
    monthlyInclGstCents: 6900,
    includedIn: ["scale"],
  },
  {
    slug: "client-forms",
    name: "Client Forms",
    category: "Client & CRM",
    monthlyInclGstCents: 4900,
    includedIn: ["launch", "growth", "scale"],
    note: "Enabled on every tier in the sheet; the price applies to standalone purchase.",
  },
  {
    slug: "borrowing-capacity",
    name: "Borrowing Capacity",
    category: "Client & CRM",
    monthlyInclGstCents: 22500,
    includedIn: ["scale"],
  },
  {
    slug: "lenders",
    name: "Lenders",
    category: "Client & CRM",
    monthlyInclGstCents: 9900,
    includedIn: [],
    comingSoon: true,
  },
  {
    slug: "client-ai",
    name: "Client AI",
    category: "Client & CRM",
    monthlyInclGstCents: 7900,
    includedIn: ["scale"],
  },

  // Operations
  {
    slug: "agreements",
    name: "Agreements",
    category: "Operations",
    monthlyInclGstCents: 6900,
    includedIn: ["scale"],
  },
  {
    slug: "marketing",
    name: "Marketing",
    category: "Operations",
    monthlyInclGstCents: 17900,
    includedIn: ["scale"],
  },
  {
    slug: "deal-pipeline",
    name: "Deal Pipeline",
    category: "Operations",
    monthlyInclGstCents: 9900,
    includedIn: ["growth", "scale"],
  },

  // AML / CTF Compliance — the $195 that separates the headline tier prices.
  {
    slug: "aml-ctf",
    name: "AML / CTF Compliance",
    category: "AML / CTF Compliance",
    monthlyInclGstCents: 19500,
    includedIn: [],
  },

  // Administration
  {
    slug: "model-hub",
    name: "Model Hub",
    category: "Administration",
    monthlyInclGstCents: 19500,
    includedIn: ["scale"],
  },
  {
    slug: "finance-portal",
    name: "Finance Portal",
    category: "Administration",
    monthlyInclGstCents: 22500,
    includedIn: ["scale"],
    note: "Also unlocks client Send To Finance and Finance Messages.",
  },
  {
    slug: "integrations",
    name: "Integrations",
    category: "Administration",
    monthlyInclGstCents: 13500,
    includedIn: [],
    note: "Subject to the client integrating their own APIs.",
  },
  {
    slug: "api-usage",
    name: "API Usage",
    category: "Administration",
    monthlyInclGstCents: 14900,
    includedIn: ["scale"],
  },

  // AI Assistant
  {
    slug: "aurixa-agent",
    name: "Aurixa Agent",
    category: "AI Assistant",
    monthlyInclGstCents: 37500,
    includedIn: [],
  },
];

/** The module whose price is the gap between a tier's two headline figures. */
export const AML_MODULE_SLUG = "aml-ctf";

export const moduleBySlug = (slug: string): PricedModule | undefined =>
  MODULES.find((m) => m.slug === slug);

export const tierBySlug = (slug: string): Tier | undefined => TIERS.find((t) => t.slug === slug);

/** Tax-inclusive price of a tier, for a billing period, with or without AML/CTF. */
export function tierPriceCents(
  tier: Tier,
  opts: { period?: BillingPeriod; withAml?: boolean } = {},
): number {
  const aml = moduleBySlug(AML_MODULE_SLUG);
  const monthly = tier.monthlyInclGstCents + (opts.withAml && aml ? aml.monthlyInclGstCents : 0);
  return opts.period === "annual" ? annualCents(monthly) : monthly;
}

/** Whether a tier includes a module without paying for it separately. */
export function tierIncludesModule(tierSlug: string, moduleSlug: string): boolean {
  return moduleBySlug(moduleSlug)?.includedIn.includes(tierSlug) ?? false;
}

/** Modules a tier does NOT include, i.e. what it can still be upgraded with. */
export function upgradesFor(tierSlug: string): readonly PricedModule[] {
  return MODULES.filter((m) => !m.includedIn.includes(tierSlug));
}
