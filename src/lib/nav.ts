// Single source of truth for primary navigation.
//
// The sidebar (app-shell), the ⌘K command palette, and the vim `g`-then-key
// shortcuts all derive from this list, so they can never drift out of sync.
// `to` is typed against the router, so a typo or a removed route fails
// typecheck instead of shipping a dead link.
import type { LinkProps } from "@tanstack/react-router";
import type { LucideIcon } from "lucide-react";
import {
  Activity,
  AlertTriangle,
  ArrowRightLeft,
  BarChart3,
  Bell,
  Boxes,
  Bot,
  CalendarClock,
  CheckCircle2,
  Cloud,
  Crown,
  Coins,
  GitFork,
  Handshake,
  LayoutDashboard,
  Newspaper,
  Palette,
  Receipt,
  ScrollText,
  Settings,
  Shield,
  ShieldCheck,
  ShoppingCart,
  Sparkles,
  Tags,
  Target,
  TreePine,
  UserPlus,
  Users,
  Waves,
} from "lucide-react";

export type NavItem = {
  to: LinkProps["to"];
  label: string;
  icon: LucideIcon;
  /** Extra search terms for the command palette fuzzy match. */
  keywords?: string;
  /** Single key for the `g`-then-key vim shortcut (must be unique). */
  shortcut?: string;
};

export type NavSection = {
  heading: string;
  items: NavItem[];
};

export const NAV_SECTIONS: NavSection[] = [
  {
    heading: "Fleet",
    items: [
      {
        to: "/dashboard",
        label: "Fleet",
        icon: LayoutDashboard,
        shortcut: "d",
        keywords: "overview clones home",
      },
      {
        to: "/clones/new",
        label: "New Clone",
        icon: GitFork,
        keywords: "create provision fork template",
      },
      { to: "/modules", label: "Modules", icon: Boxes, shortcut: "m" },
      {
        to: "/cascades",
        label: "Cascades",
        icon: Waves,
        shortcut: "c",
        keywords: "push update pull request",
      },
      {
        to: "/schedules",
        label: "Schedules",
        icon: CalendarClock,
        shortcut: "s",
        keywords: "cron recurring",
      },
      { to: "/drift", label: "Drift", icon: Sparkles, shortcut: "r", keywords: "ai suggestions" },
      { to: "/branding", label: "Branding", icon: Palette, shortcut: "b" },
      {
        to: "/fleet-manager",
        label: "AI Manager",
        icon: Bot,
        shortcut: "f",
        keywords: "assistant",
      },
      {
        to: "/yggdrasil",
        label: "Yggdrasil",
        icon: TreePine,
        shortcut: "y",
        keywords: "tree visualization graph",
      },
    ],
  },
  {
    heading: "Observability",
    items: [
      { to: "/health", label: "Health", icon: Activity, shortcut: "h", keywords: "uptime status" },
      { to: "/metrics", label: "Metrics", icon: BarChart3, shortcut: "i" },
      { to: "/slo", label: "SLO", icon: Target, shortcut: "l", keywords: "service level" },
      { to: "/digests", label: "Digests", icon: Newspaper, shortcut: "g" },
      { to: "/report-jobs", label: "Report Jobs", icon: Receipt, keywords: "reports export" },
      {
        to: "/audit-log",
        label: "Audit Log",
        icon: ScrollText,
        shortcut: "a",
        keywords: "activity history",
      },
      {
        to: "/oversight",
        label: "Oversight",
        icon: Crown,
        shortcut: "o",
        keywords: "high king sovereign tiers actions",
      },
      {
        to: "/route-errors",
        label: "Route Errors",
        icon: AlertTriangle,
        keywords: "crashes telemetry",
      },
    ],
  },
  {
    heading: "Security",
    items: [
      {
        to: "/approvals",
        label: "Approvals",
        icon: CheckCircle2,
        shortcut: "q",
        keywords: "queue review",
      },
      {
        to: "/cloudflare",
        label: "Cloudflare",
        icon: Cloud,
        shortcut: "e",
        keywords: "wrapper cdn",
      },
      { to: "/fleet/edge", label: "Edge Security", icon: Shield, keywords: "waf posture" },
      {
        to: "/security-partners",
        label: "Security Partners",
        icon: ShieldCheck,
        keywords: "pentest",
      },
    ],
  },
  {
    heading: "Growth",
    items: [
      { to: "/leads", label: "Leads", icon: UserPlus, keywords: "waitlist crm contacts" },
      { to: "/handoffs", label: "Handoffs", icon: ArrowRightLeft, keywords: "client transfer" },
      { to: "/partner-portal", label: "Partner Portal", icon: Handshake, keywords: "resellers" },
    ],
  },
  {
    heading: "Billing",
    items: [
      { to: "/billing/seats", label: "Seats", icon: Users },
      { to: "/billing/purchases", label: "Purchases", icon: ShoppingCart },
      {
        to: "/billing/catalog",
        label: "Pricing Catalog",
        icon: Tags,
        keywords: "prices plans packs",
      },
      { to: "/billing/topup", label: "Top-up", icon: Coins, keywords: "tokens credits" },
    ],
  },
  {
    heading: "System",
    items: [
      { to: "/notifications", label: "Notifications", icon: Bell, shortcut: "n" },
      { to: "/settings", label: "Settings", icon: Settings, keywords: "configuration preferences" },
    ],
  },
];

/** Flattened list of every nav item, in section order. */
export const NAV_ITEMS: NavItem[] = NAV_SECTIONS.flatMap((section) => section.items);

/** `g`-then-key shortcut map, keyed by the single shortcut char. */
export const NAV_SHORTCUTS: Record<string, NavItem> = Object.fromEntries(
  NAV_ITEMS.filter((item) => item.shortcut).map((item) => [item.shortcut as string, item]),
);
