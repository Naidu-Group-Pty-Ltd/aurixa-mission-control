import { createFileRoute, Link, Outlet, useLocation } from "@tanstack/react-router";
import { ProtectedRoute } from "@/components/protected-route";
import { cn } from "@/lib/utils";
import {
  Cog,
  BellRing,
  Shield,
  Eye,
  ScrollText,
  Grid3x3,
  Wallet,
  Gift,
  MailPlus,
  ArrowRightLeft,
  Globe,
  Users,
  Github,
  FileText,
  CreditCard,
} from "lucide-react";

export const Route = createFileRoute("/settings")({
  component: () => (
    <ProtectedRoute>
      <SettingsLayout />
    </ProtectedRoute>
  ),
  head: () => ({ meta: [{ title: "Settings — Aurixa Systems Mission Control" }] }),
});

const TABS = [
  { to: "/settings", label: "General", icon: Cog, exact: true },
  { to: "/settings/notifications", label: "Notifications", icon: BellRing, exact: false },
  { to: "/settings/roles", label: "Roles", icon: Shield, exact: false },
  { to: "/settings/invites", label: "Invites", icon: MailPlus, exact: false },
  { to: "/settings/role-audit", label: "Role Audit", icon: ScrollText, exact: false },
  { to: "/settings/permission-matrix", label: "Matrix", icon: Grid3x3, exact: false },
  { to: "/settings/billing", label: "Billing", icon: Wallet, exact: false },
  { to: "/settings/clone-stripe", label: "Clone Stripe", icon: CreditCard, exact: false },
  { to: "/settings/gift-tokens", label: "Gift Tokens", icon: Gift, exact: false },
  {
    to: "/settings/handoff-policies",
    label: "Handoff Policies",
    icon: ArrowRightLeft,
    exact: false,
  },
  { to: "/settings/handoff-terms", label: "Handoff Terms", icon: FileText, exact: false },
  { to: "/settings/provisioning-preview", label: "Provisioning", icon: Eye, exact: false },
  { to: "/settings/domains", label: "Domains", icon: Globe, exact: false },
  { to: "/settings/github-access", label: "GitHub Access", icon: Github, exact: false },
  { to: "/settings/client-accounts", label: "Client Accounts", icon: Users, exact: false },
] as const;

function SettingsLayout() {
  const loc = useLocation();
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <p className="font-mono text-[11px] uppercase tracking-[0.25em] text-muted-foreground">
          configuration
        </p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Settings</h1>
      </header>

      <nav className="flex gap-1 overflow-x-auto rounded-md border border-border bg-surface p-1">
        {TABS.map((t) => {
          const active = t.exact ? loc.pathname === t.to : loc.pathname.startsWith(t.to);
          const Icon = t.icon;
          return (
            <Link
              key={t.to}
              to={t.to}
              className={cn(
                "flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded px-3 py-2 font-mono text-[11px] uppercase tracking-wider transition-colors",
                active
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {t.label}
            </Link>
          );
        })}
      </nav>

      <Outlet />
    </div>
  );
}
