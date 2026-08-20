// G11 — Public client onboarding wizard. Unauthenticated. Redeems a
// handoff invite token, walks the client through creating a Supabase
// project, minting a PAT, signing the DPA, and submitting everything
// back via /api/public/handoffs/consent.
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";
import { ArrowRight, CheckCircle2, ExternalLink, ShieldCheck, KeyRound, FileSignature } from "lucide-react";

type InviteContext = {
  invite: {
    terms_version: string;
    terms_hash: string;
    terms_body: string;
    region_allowlist: string[];
    plan_allowlist: string[];
    expires_at: string;
  };
  handoff: {
    state: string;
    target_region: string | null;
    target_plan_tier: string | null;
    clone_name: string | null;
    clone_slug: string | null;
  } | null;
};

export const Route = createFileRoute("/clients/handoff/$token")({
  component: ClientHandoffWizard,
  head: () => ({
    meta: [
      { title: "Complete your Aurixa Systems handoff" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
});

const DEFAULT_REGIONS = [
  "us-east-1",
  "us-west-1",
  "eu-west-1",
  "eu-central-1",
  "ap-southeast-1",
  "ap-southeast-2",
];
const DEFAULT_PLANS = ["free", "pro", "team", "enterprise"];

function ClientHandoffWizard() {
  const { token } = Route.useParams();
  const [ctx, setCtx] = useState<InviteContext | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [step, setStep] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  const [form, setForm] = useState({
    owner_name: "",
    owner_email: "",
    org_id: "",
    org_slug: "",
    target_region: "",
    target_plan_tier: "",
    pat: "",
    signed_by_name: "",
    dpa_accepted: false,
    notes: "",
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/public/handoffs/consent?token=${encodeURIComponent(token)}`,
          { headers: { Accept: "application/json" } },
        );
        const body = await res.json();
        if (!res.ok || !body.ok) {
          if (!cancelled) setLoadError(body.error ?? `error_${res.status}`);
          return;
        }
        if (!cancelled) {
          setCtx(body as InviteContext);
          setForm((f) => ({
            ...f,
            target_region: body.handoff?.target_region ?? "",
            target_plan_tier: body.handoff?.target_plan_tier ?? "",
          }));
        }
      } catch (err: any) {
        if (!cancelled) setLoadError(err?.message ?? "network_error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const regionChoices = useMemo(() => {
    const allow = ctx?.invite.region_allowlist ?? [];
    return allow.length ? allow : DEFAULT_REGIONS;
  }, [ctx]);
  const planChoices = useMemo(() => {
    const allow = ctx?.invite.plan_allowlist ?? [];
    return allow.length ? allow : DEFAULT_PLANS;
  }, [ctx]);

  if (loadError) {
    return (
      <FullBleed>
        <Card className="max-w-lg">
          <CardHeader>
            <CardTitle>This handoff link is unavailable</CardTitle>
            <CardDescription>
              {loadError === "invite_expired"
                ? "The link has expired. Ask your Aurixa contact for a new one."
                : loadError === "invite_already_used"
                  ? "This link was already used. Contact Aurixa if you need to resubmit."
                  : loadError === "invite_revoked"
                    ? "This link was revoked. Contact your Aurixa contact for a fresh invite."
                    : loadError === "invite_not_found"
                      ? "That link is not recognised. Double-check you copied the whole URL."
                      : "We couldn't load this invite. Please try again shortly."}
            </CardDescription>
          </CardHeader>
        </Card>
      </FullBleed>
    );
  }

  if (!ctx) {
    return (
      <FullBleed>
        <div className="animate-pulse text-muted-foreground">Loading your handoff…</div>
      </FullBleed>
    );
  }

  if (done) {
    return (
      <FullBleed>
        <Card className="max-w-lg">
          <CardHeader>
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-6 w-6 text-emerald-500" />
              <CardTitle>Consent received</CardTitle>
            </div>
            <CardDescription>
              Thanks. Your Supabase org details and signed DPA were handed over
              securely. Your Aurixa contact will kick off the twin provisioning
              step next and email you when it's ready to review.
            </CardDescription>
          </CardHeader>
        </Card>
      </FullBleed>
    );
  }

  const canNext = (s: number) => {
    if (s === 0) return true;
    if (s === 1)
      return (
        form.owner_name.trim().length > 0 &&
        form.owner_email.trim().length > 0 &&
        form.org_id.trim().length > 0
      );
    if (s === 2) return form.target_region && form.target_plan_tier;
    if (s === 3) return form.pat.trim().length >= 20;
    if (s === 4) return form.dpa_accepted && form.signed_by_name.trim().length > 0;
    return true;
  };

  const submit = async () => {
    setSubmitting(true);
    try {
      const res = await fetch("/api/public/handoffs/consent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          org_id: form.org_id.trim(),
          org_slug: form.org_slug.trim() || null,
          owner_email: form.owner_email.trim(),
          owner_name: form.owner_name.trim(),
          pat: form.pat.trim(),
          target_region: form.target_region,
          target_plan_tier: form.target_plan_tier,
          terms_version: ctx.invite.terms_version,
          terms_hash_ack: ctx.invite.terms_hash,
          signed_by_name: form.signed_by_name.trim(),
          dpa_accepted: true,
          notes: form.notes.trim() || null,
        }),
      });
      const body = await res.json();
      if (!res.ok || !body.ok) {
        toast.error(`Submission failed: ${body.error ?? res.status}`);
        return;
      }
      setDone(true);
    } catch (err: any) {
      toast.error(`Network error: ${err?.message ?? "unknown"}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <FullBleed>
      <div className="w-full max-w-2xl space-y-6">
        <header className="space-y-1">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-primary" />
            <h1 className="text-2xl font-semibold">
              Handoff for {ctx.handoff?.clone_name ?? "your Aurixa clone"}
            </h1>
          </div>
          <p className="text-sm text-muted-foreground">
            Complete these steps to transfer ownership of your dedicated Aurixa
            Systems backend into your own Supabase organisation. Everything you
            submit is encrypted at rest — your personal access token is stored
            with AES-256-GCM and only used to provision the new project.
          </p>
          <div className="flex items-center gap-2 pt-1 text-xs text-muted-foreground">
            <Badge variant="outline">Terms {ctx.invite.terms_version}</Badge>
            <span>Link expires {new Date(ctx.invite.expires_at).toLocaleString()}</span>
          </div>
        </header>

        <Stepper step={step} total={5} />

        {step === 0 && (
          <StepCard
            title="1. Create your Supabase organisation"
            icon={<ExternalLink className="h-5 w-5" />}
            description="If you don't already have a Supabase account, create one and set up a fresh organisation dedicated to this Aurixa clone."
          >
            <ol className="list-decimal space-y-2 pl-5 text-sm">
              <li>
                Open{" "}
                <a
                  href="https://supabase.com/dashboard/sign-up"
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary underline"
                >
                  supabase.com/dashboard
                </a>{" "}
                in a new tab and sign up (or sign in).
              </li>
              <li>
                Create a new organisation. Any plan tier that's on the allowlist
                for this handoff will work.
              </li>
              <li>
                From <em>Organization settings</em>, copy your <strong>Organization ID</strong>{" "}
                (starts with <code>abcdef…</code>) — you'll paste it in step 2.
              </li>
            </ol>
          </StepCard>
        )}

        {step === 1 && (
          <StepCard
            title="2. Confirm your details"
            icon={<KeyRound className="h-5 w-5" />}
            description="These are the primary contact and Supabase org receiving the handoff."
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Your full name" required>
                <Input
                  value={form.owner_name}
                  onChange={(e) => setForm({ ...form, owner_name: e.target.value })}
                  autoComplete="name"
                />
              </Field>
              <Field label="Contact email" required>
                <Input
                  type="email"
                  value={form.owner_email}
                  onChange={(e) => setForm({ ...form, owner_email: e.target.value })}
                  autoComplete="email"
                />
              </Field>
              <Field label="Supabase organization ID" required>
                <Input
                  value={form.org_id}
                  onChange={(e) => setForm({ ...form, org_id: e.target.value })}
                  placeholder="abcd1234efgh…"
                />
              </Field>
              <Field label="Organization slug (optional)">
                <Input
                  value={form.org_slug}
                  onChange={(e) => setForm({ ...form, org_slug: e.target.value })}
                  placeholder="my-org"
                />
              </Field>
            </div>
          </StepCard>
        )}

        {step === 2 && (
          <StepCard
            title="3. Choose region and plan"
            icon={<ShieldCheck className="h-5 w-5" />}
            description="Pick where the new Supabase project will run and which plan tier to provision under."
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Target region" required>
                <select
                  value={form.target_region}
                  onChange={(e) => setForm({ ...form, target_region: e.target.value })}
                  className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="">Select region…</option>
                  {regionChoices.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Plan tier" required>
                <select
                  value={form.target_plan_tier}
                  onChange={(e) => setForm({ ...form, target_plan_tier: e.target.value })}
                  className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="">Select plan…</option>
                  {planChoices.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            {(ctx.invite.region_allowlist.length > 0 ||
              ctx.invite.plan_allowlist.length > 0) && (
              <p className="text-xs text-muted-foreground">
                Regions and plans above are restricted by your agreement with
                Aurixa Systems.
              </p>
            )}
          </StepCard>
        )}

        {step === 3 && (
          <StepCard
            title="4. Provide a personal access token"
            icon={<KeyRound className="h-5 w-5" />}
            description="Aurixa needs a Supabase PAT to create the new project in your organisation. It's encrypted immediately and can be revoked from your Supabase dashboard once handoff is complete."
          >
            <ol className="list-decimal space-y-2 pl-5 text-sm">
              <li>
                Open{" "}
                <a
                  href="https://supabase.com/dashboard/account/tokens"
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary underline"
                >
                  supabase.com/dashboard/account/tokens
                </a>
                .
              </li>
              <li>
                Generate a token labelled <code>Aurixa handoff</code>.
              </li>
              <li>Paste it below. It will not be displayed again after submit.</li>
            </ol>
            <Field label="Personal access token" required>
              <Input
                type="password"
                value={form.pat}
                onChange={(e) => setForm({ ...form, pat: e.target.value })}
                placeholder="sbp_…"
                autoComplete="off"
              />
            </Field>
            <Field label="Notes for Aurixa (optional)">
              <Textarea
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                rows={3}
                placeholder="Anything we should know before provisioning?"
              />
            </Field>
          </StepCard>
        )}

        {step === 4 && (
          <StepCard
            title="5. Review and sign the DPA"
            icon={<FileSignature className="h-5 w-5" />}
            description={`Terms version ${ctx.invite.terms_version}. Read the agreement below, then type your name to sign.`}
          >
            <div className="max-h-64 overflow-y-auto rounded-md border bg-muted/30 p-3 text-xs whitespace-pre-wrap">
              {ctx.invite.terms_body}
            </div>
            <p className="text-[10px] font-mono text-muted-foreground break-all">
              Terms hash: {ctx.invite.terms_hash}
            </p>
            <div className="flex items-start gap-2">
              <Checkbox
                id="dpa"
                checked={form.dpa_accepted}
                onCheckedChange={(v) => setForm({ ...form, dpa_accepted: v === true })}
              />
              <label htmlFor="dpa" className="text-sm">
                I have read the terms above and I have authority to bind my
                organisation to them.
              </label>
            </div>
            <Field label="Type your full legal name to sign" required>
              <Input
                value={form.signed_by_name}
                onChange={(e) => setForm({ ...form, signed_by_name: e.target.value })}
                autoComplete="off"
              />
            </Field>
          </StepCard>
        )}

        <div className="flex items-center justify-between">
          <Button
            variant="ghost"
            onClick={() => setStep((s) => Math.max(0, s - 1))}
            disabled={step === 0 || submitting}
          >
            Back
          </Button>
          {step < 4 ? (
            <Button
              onClick={() => setStep((s) => s + 1)}
              disabled={!canNext(step)}
            >
              Continue <ArrowRight className="ml-1 h-4 w-4" />
            </Button>
          ) : (
            <Button onClick={submit} disabled={!canNext(4) || submitting}>
              {submitting ? "Submitting…" : "Submit signed handoff"}
            </Button>
          )}
        </div>
      </div>
    </FullBleed>
  );
}

function FullBleed({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-background px-4 py-10">
      <div className="mx-auto flex w-full max-w-3xl flex-col items-start gap-6">
        {children}
      </div>
    </main>
  );
}

function Stepper({ step, total }: { step: number; total: number }) {
  return (
    <div className="flex items-center gap-2">
      {Array.from({ length: total }).map((_, i) => (
        <div
          key={i}
          className={`h-1.5 flex-1 rounded-full ${i <= step ? "bg-primary" : "bg-muted"}`}
        />
      ))}
    </div>
  );
}

function StepCard({
  title,
  description,
  icon,
  children,
}: {
  title: string;
  description: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card className="w-full">
      <CardHeader>
        <div className="flex items-center gap-2">
          {icon}
          <CardTitle className="text-lg">{title}</CardTitle>
        </div>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">{children}</CardContent>
    </Card>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-sm">
        {label}
        {required ? <span className="text-destructive"> *</span> : null}
      </Label>
      {children}
    </div>
  );
}
