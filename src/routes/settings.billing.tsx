import { createFileRoute, Link } from "@tanstack/react-router";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { OverviewTab } from "@/components/billing/overview-tab";
import { TenantsTab } from "@/components/billing/tenants-tab";
import { PlansPacksTab } from "@/components/billing/plans-packs-tab";
import { RatesTab } from "@/components/billing/rates-tab";
import { KeysTab } from "@/components/billing/keys-tab";
import { WebhooksTab } from "@/components/billing/webhooks-tab";

export const Route = createFileRoute("/settings/billing")({
  component: BillingDashboard,
  head: () => ({ meta: [{ title: "Billing & Tokens — Mission Control" }] }),
});

function BillingDashboard() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="label-mono">monetization</p>
          <h2 className="mt-1 text-2xl font-semibold tracking-tight">Billing &amp; Tokens</h2>
        </div>
        <Link
          to="/settings"
          className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground hover:text-foreground"
        >
          ← back
        </Link>
      </div>

      <Tabs defaultValue="overview" className="space-y-4">
        <TabsList className="grid w-full grid-cols-6">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="tenants">Tenants</TabsTrigger>
          <TabsTrigger value="plans">Plans &amp; Packs</TabsTrigger>
          <TabsTrigger value="rates">Rates</TabsTrigger>
          <TabsTrigger value="keys">API Keys</TabsTrigger>
          <TabsTrigger value="webhooks">Webhooks</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          <OverviewTab />
        </TabsContent>
        <TabsContent value="tenants">
          <TenantsTab />
        </TabsContent>
        <TabsContent value="plans">
          <PlansPacksTab />
        </TabsContent>
        <TabsContent value="rates">
          <RatesTab />
        </TabsContent>
        <TabsContent value="keys">
          <KeysTab />
        </TabsContent>
        <TabsContent value="webhooks">
          <WebhooksTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
