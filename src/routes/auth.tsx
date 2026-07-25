import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useAuth } from "@/lib/auth";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Radio, MailCheck, Loader2, ArrowLeft, Lock } from "lucide-react";
import { toast } from "sonner";

type AuthSearch = { redirect?: string; intent?: string; clone?: string; h?: string };

export const Route = createFileRoute("/auth")({
  component: AuthPage,
  validateSearch: (s: Record<string, unknown>): AuthSearch => ({
    redirect: typeof s.redirect === "string" ? s.redirect : undefined,
    intent: typeof s.intent === "string" ? s.intent : undefined,
    clone: typeof s.clone === "string" ? s.clone : undefined,
    // Billing handoff token — must survive the auth round-trip so the
    // attributed purchase flow can resume (user-attributed pricing workflow).
    h: typeof s.h === "string" ? s.h : undefined,
  }),
  head: () => ({ meta: [{ title: "Sign in — Aurixa Systems Mission Control" }] }),
});

const emailField = z.string().min(1, "Email is required").email("Enter a valid email");
const credsSchema = z.object({
  email: emailField,
  password: z.string().min(6, "Password must be at least 6 characters"),
});
type Creds = z.infer<typeof credsSchema>;
const recoverySchema = z.object({ email: emailField });
type RecoveryValues = z.infer<typeof recoverySchema>;

function AuthPage() {
  const { session, signIn } = useAuth();
  const nav = useNavigate();
  const search = useSearch({ from: "/auth" }) as AuthSearch;
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<"auth" | "recovery">("auth");
  const [recoverySent, setRecoverySent] = useState<string | null>(null);
  const isPartnerIntent =
    search.intent === "partner" || search.redirect?.startsWith("/partner-portal");

  const form = useForm<Creds>({
    resolver: zodResolver(credsSchema),
    defaultValues: { email: "", password: "" },
  });
  const recoveryForm = useForm<RecoveryValues>({
    resolver: zodResolver(recoverySchema),
    defaultValues: { email: "" },
  });

  useEffect(() => {
    if (session) {
      const defaultDest = isPartnerIntent ? "/partner-portal" : "/dashboard";
      const dest =
        search.redirect && search.redirect.startsWith("/") ? search.redirect : defaultDest;
      const params = new URLSearchParams();
      if (search.intent) params.set("intent", search.intent);
      if (search.clone) params.set("clone", search.clone);
      if (search.h) params.set("h", search.h);
      const qs = params.toString();
      const sep = dest.includes("?") ? "&" : "?";
      nav({ to: (qs ? `${dest}${sep}${qs}` : dest) as never });
    }
  }, [session, nav, search.redirect, search.intent, search.clone, search.h, isPartnerIntent]);

  const onSubmit = async (values: Creds) => {
    setBusy(true);
    const { error } = await signIn(values.email, values.password);
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Welcome back");
  };

  const onRecovery = async (values: RecoveryValues) => {
    setBusy(true);
    const { error } = await supabase.auth.resetPasswordForEmail(values.email, {
      redirectTo:
        typeof window !== "undefined" ? `${window.location.origin}/reset-password` : undefined,
    });
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    setRecoverySent(values.email);
    toast.success("Password reset link sent");
  };

  return (
    <div className="grid-bg flex min-h-dvh items-center justify-center p-6">
      <div className="w-full max-w-md space-y-6">
        <Card className="border-border/80 bg-card/90 backdrop-blur">
          <CardHeader className="items-center text-center">
            <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-md bg-primary/15 ring-1 ring-primary/40">
              <Radio className="h-6 w-6 text-primary" />
            </div>
            <CardTitle className="font-mono tracking-wide">
              {isPartnerIntent
                ? "AURIXA SYSTEMS · SECURITY PARTNER PORTAL"
                : "AURIXA SYSTEMS · MISSION CONTROL"}
            </CardTitle>
            <CardDescription>
              {view === "recovery"
                ? "Reset your operator password"
                : isPartnerIntent
                  ? "Restricted cybersecurity partner access for approved testing cycles"
                  : "Operator access required"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {view === "recovery" ? (
              recoverySent ? (
                <Alert className="border-primary/40 bg-primary/5">
                  <MailCheck className="h-4 w-4 text-primary" />
                  <AlertTitle className="font-mono text-sm">Check your inbox</AlertTitle>
                  <AlertDescription className="space-y-3 text-xs text-muted-foreground">
                    <p>
                      If an account exists for{" "}
                      <span className="font-mono text-foreground">{recoverySent}</span>, a
                      password-reset link is on its way. Follow it to set a new password.
                    </p>
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        setView("auth");
                        setRecoverySent(null);
                      }}
                    >
                      <ArrowLeft className="mr-1.5 h-3.5 w-3.5" /> Back to sign in
                    </Button>
                  </AlertDescription>
                </Alert>
              ) : (
                <Form {...recoveryForm}>
                  <form onSubmit={recoveryForm.handleSubmit(onRecovery)} className="space-y-4">
                    <FormField
                      control={recoveryForm.control}
                      name="email"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Email</FormLabel>
                          <FormControl>
                            <Input type="email" autoComplete="email" autoFocus {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <Button type="submit" className="w-full" disabled={busy}>
                      {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      {busy ? "Sending link…" : "Send reset link"}
                    </Button>
                    <button
                      type="button"
                      className="mx-auto block text-xs text-muted-foreground hover:text-foreground"
                      onClick={() => setView("auth")}
                    >
                      ← Back to sign in
                    </button>
                  </form>
                </Form>
              )
            ) : (
              <Form {...form}>
                <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                  <FormField
                    control={form.control}
                    name="email"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Email</FormLabel>
                        <FormControl>
                          <Input type="email" autoComplete="email" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="password"
                    render={({ field }) => (
                      <FormItem>
                        <div className="flex items-center justify-between">
                          <FormLabel>Password</FormLabel>
                          <button
                            type="button"
                            className="text-xs text-muted-foreground hover:text-foreground"
                            onClick={() => setView("recovery")}
                          >
                            Forgot password?
                          </button>
                        </div>
                        <FormControl>
                          <Input type="password" autoComplete="current-password" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <Button type="submit" className="w-full" disabled={busy}>
                    {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    {busy ? "Signing in…" : "Sign in"}
                  </Button>
                </form>
              </Form>
            )}

            {view === "auth" && (
              <div className="mt-6 flex items-start gap-2.5 rounded-md border border-border/60 bg-muted/30 px-3 py-2.5">
                <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <p className="text-xs text-muted-foreground">
                  This is a closed system — self-serve registration is disabled. Access is granted
                  exclusively through invite links issued by a super admin. If you were sent an
                  invite, open its link to create your account.
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
