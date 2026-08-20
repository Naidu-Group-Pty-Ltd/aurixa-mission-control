// Per-tier sub-module availability, generated from the pricing sheet's own
// tier matrices rather than transcribed by hand — 34 sub-modules across three
// tiers is exactly the kind of table that rots when it is copied manually.
//
// `key` is the stable identifier a clone gates on. It is derived from the
// module and sub-module names, so it survives a rename of the display text.
//
// Two sub-modules are off on every tier, and both are deliberate: Emails is
// unlocked by the Email Copilot module, and Lenders is still in development.

export type SubModuleEntitlement = {
  module: string;
  subModule: string;
  key: string;
  launch: boolean;
  growth: boolean;
  scale: boolean;
};

export const SUB_MODULE_MATRIX: readonly SubModuleEntitlement[] = [
  {
    module: "Generated Reports",
    subModule: "Investment",
    key: "generated-reports.investment",
    launch: true,
    growth: true,
    scale: true,
  },
  {
    module: "Generated Reports",
    subModule: "Comparisons",
    key: "generated-reports.comparisons",
    launch: false,
    growth: true,
    scale: true,
  },
  {
    module: "Cash Flow Analysis",
    subModule: "10 Year Cash Flow",
    key: "cash-flow-analysis.10-year-cash-flow",
    launch: true,
    growth: true,
    scale: true,
  },
  {
    module: "Cash Flow Analysis",
    subModule: "Comparisons",
    key: "cash-flow-analysis.comparisons",
    launch: false,
    growth: true,
    scale: true,
  },
  {
    module: "Clients",
    subModule: "Send To Finance",
    key: "clients.send-to-finance",
    launch: false,
    growth: false,
    scale: true,
  },
  {
    module: "Clients",
    subModule: "Review",
    key: "clients.review",
    launch: true,
    growth: true,
    scale: true,
  },
  {
    module: "Clients",
    subModule: "Portfolio Analysis",
    key: "clients.portfolio-analysis",
    launch: false,
    growth: false,
    scale: true,
  },
  {
    module: "Clients",
    subModule: "Download Client Details PDF",
    key: "clients.download-client-details-pdf",
    launch: true,
    growth: true,
    scale: true,
  },
  {
    module: "Clients",
    subModule: "Send Portfolio To Client",
    key: "clients.send-portfolio-to-client",
    launch: false,
    growth: false,
    scale: true,
  },
  {
    module: "Clients",
    subModule: "Send Agreement",
    key: "clients.send-agreement",
    launch: false,
    growth: false,
    scale: true,
  },
  {
    module: "Clients",
    subModule: "Portal Access",
    key: "clients.portal-access",
    launch: true,
    growth: true,
    scale: true,
  },
  {
    module: "Clients",
    subModule: "View As Client",
    key: "clients.view-as-client",
    launch: true,
    growth: true,
    scale: true,
  },
  {
    module: "Clients",
    subModule: "Overview",
    key: "clients.overview",
    launch: true,
    growth: true,
    scale: true,
  },
  {
    module: "Clients",
    subModule: "Personal",
    key: "clients.personal",
    launch: true,
    growth: true,
    scale: true,
  },
  {
    module: "Clients",
    subModule: "Properties",
    key: "clients.properties",
    launch: true,
    growth: true,
    scale: true,
  },
  {
    module: "Clients",
    subModule: "Deals",
    key: "clients.deals",
    launch: false,
    growth: true,
    scale: true,
  },
  {
    module: "Clients",
    subModule: "Employment",
    key: "clients.employment",
    launch: true,
    growth: true,
    scale: true,
  },
  {
    module: "Clients",
    subModule: "Financials",
    key: "clients.financials",
    launch: true,
    growth: true,
    scale: true,
  },
  {
    module: "Clients",
    subModule: "Reports",
    key: "clients.reports",
    launch: true,
    growth: true,
    scale: true,
  },
  {
    module: "Clients",
    subModule: "Sent Reports",
    key: "clients.sent-reports",
    launch: true,
    growth: true,
    scale: true,
  },
  {
    module: "Clients",
    subModule: "Requests",
    key: "clients.requests",
    launch: true,
    growth: true,
    scale: true,
  },
  {
    module: "Clients",
    subModule: "Emails",
    key: "clients.emails",
    launch: false,
    growth: false,
    scale: false,
  },
  {
    module: "Clients",
    subModule: "Conversations",
    key: "clients.conversations",
    launch: false,
    growth: false,
    scale: true,
  },
  {
    module: "Clients",
    subModule: "Appointments",
    key: "clients.appointments",
    launch: false,
    growth: false,
    scale: true,
  },
  {
    module: "Clients",
    subModule: "Portal Messages",
    key: "clients.portal-messages",
    launch: true,
    growth: true,
    scale: true,
  },
  {
    module: "Clients",
    subModule: "Finance Messages",
    key: "clients.finance-messages",
    launch: false,
    growth: false,
    scale: true,
  },
  {
    module: "Clients",
    subModule: "Notes",
    key: "clients.notes",
    launch: true,
    growth: true,
    scale: true,
  },
  {
    module: "Clients",
    subModule: "Reminders",
    key: "clients.reminders",
    launch: true,
    growth: true,
    scale: true,
  },
  {
    module: "Clients",
    subModule: "Client Forms",
    key: "clients.client-forms",
    launch: true,
    growth: true,
    scale: true,
  },
  {
    module: "Clients",
    subModule: "Files",
    key: "clients.files",
    launch: true,
    growth: true,
    scale: true,
  },
  {
    module: "Clients",
    subModule: "Activity/Documents",
    key: "clients.activity-documents",
    launch: true,
    growth: true,
    scale: true,
  },
  {
    module: "Clients",
    subModule: "Borrowing Capacity",
    key: "clients.borrowing-capacity",
    launch: false,
    growth: false,
    scale: true,
  },
  {
    module: "Clients",
    subModule: "Lenders",
    key: "clients.lenders",
    launch: false,
    growth: false,
    scale: false,
  },
  {
    module: "Clients",
    subModule: "AI",
    key: "clients.ai",
    launch: false,
    growth: false,
    scale: true,
  },
];

const BY_KEY = new Map(SUB_MODULE_MATRIX.map((r) => [r.key, r]));

/** Whether a tier enables a sub-module. Unknown keys are denied, not allowed. */
export function tierEnablesSubModule(tierSlug: string, key: string): boolean {
  const row = BY_KEY.get(key);
  if (!row) return false;
  if (tierSlug === "launch") return row.launch;
  if (tierSlug === "growth") return row.growth;
  if (tierSlug === "scale") return row.scale;
  return false;
}

/** Every sub-module key a tier enables. */
export function enabledSubModules(tierSlug: string): string[] {
  return SUB_MODULE_MATRIX.filter((r) => tierEnablesSubModule(tierSlug, r.key)).map((r) => r.key);
}
