// Public invite-redemption page. The invite token in the URL is the sole
// credential — this is the only way to create an account in this closed
// system (self-serve sign-up is deprecated).
import { createFileRoute, Link, useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useServerFn } from "@tanstack/react-start";
import { validateUserInvite, acceptUserInvite } from "@/server/user-invites.functions";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
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
import { Radio, Loader2, ShieldX, MailQuestion, Clock, KeyRound } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/join/$token")({
  component: JoinPage,
  head: () => ({ meta: [{ title: "Join — Aurixa Systems Mission Control" }] }),
});

const joinSchema = z
  .object({
    displayName: z.string().min(1, "Display name is required").max(120),
    email: z.string().min(1, "Email is required").email("Enter a valid email"),
    password: z.string().min(8, "Password must be at least 8 characters"),
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, {
    path: ["confirm"],
    message: "Passwords do not match",
  });
type JoinValues = z.infer<typeof joinSchema>;

const ROLE_LABELS: Record<string, string> = {
  super_admin: "Super Admin",
  admin: "Admin",
  operator: "Operator",
  user: "User",
};

const INVALID_COPY: Record<string, { icon: typeof ShieldX; title: string; body: string }> = {
  not_found: {
    icon: MailQuestion,
    title: "Invite not found",
    body: "This invite link is not recognized. Check that you copied the full link, or ask the super admin who invited you for a fresh one.",
  },
  accepted: {
    icon: KeyRound,
    title: "Invite already used",
    body: "This invite has already been redeemed. If that was you, sign in with the account you created.",
  },
  revoked: {
    icon: ShieldX,
    title: "Invite revoked",
    body: "This invite was revoked by a super admin. Contact them if you believe this is a mistake.",
  },
  expired: {
    icon: Clock,
    title: "Invite expired",
    body: "This invite link has expired. Ask the super admin who invited you to issue a new one.",
  },
};

type InviteInfo = {
  email: string | null;
  role: string;
  expires_at: string;
  invited_by_name: string | null;
};

function JoinPage() {
  const { token } = useParams({ from: "/join/$token" });
  const { session, signIn } = useAuth();
  const nav = useNavigate();
  const validateFn = useServerFn(validateUserInvite);
  const acceptFn = useServerFn(acceptUserInvite);

  const [checking, setChecking] = useState(true);
  const [invalid, setInvalid] = useState<string | null>(null);
  const [invite, setInvite] = useState<InviteInfo | null>(null);
  const [busy, setBusy] = useState(false);

  const form = useForm<JoinValues>({
    resolver: zodResolver(joinSchema),
    defaultValues: { displayName: "", email: "", password: "", confirm: "" },
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await validateFn({ data: { token } });
        if (cancelled) return;
        if (res.ok) {
          setInvite({
            email: res.email,
            role: res.role,
            expires_at: res.expires_at,
            invited_by_name: res.invited_by_name,
          });
          if (res.email) form.setValue("email", res.email);
        } else {
          setInvalid(res.reason);
        }
      } catch {
        if (!cancelled) setInvalid("not_found");
      } finally {
        if (!cancelled) setChecking(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- validate once per token
  }, [token]);

  const onSubmit = async (values: JoinValues) => {
    setBusy(true);
    try {
      const res = await acceptFn({
        data: {
          token,
          email: values.email,
          password: values.password,
          displayName: values.displayName,
        },
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Account created — welcome aboard");
      const { error } = await signIn(values.email, values.password);
      if (error) {
        // Account exists; the sign-in just hiccuped. Send them to /auth.
        nav({ to: "/auth" });
        return;
      }
      nav({ to: "/dashboard" });
    } finally {
      setBusy(false);
    }
  };

  const emailLocked = Boolean(invite?.email);

  return (
    <div className="grid-bg flex min-h-dvh items-center justify-center p-6">
      <div className="w-full max-w-md space-y-6">
        <Card className="border-border/80 bg-card/90 backdrop-blur">
          <CardHeader className="items-center text-center">
            <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-md bg-primary/15 ring-1 ring-primary/40">
              <Radio className="h-6 w-6 text-primary" />
            </div>
            <CardTitle className="font-mono tracking-wide">
              AURIXA SYSTEMS · MISSION CONTROL
            </CardTitle>
            <CardDescription>
              {checking
                ? "Verifying your invite…"
                : invite
                  ? "You've been invited — create your operator account"
                  : "Invite verification"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {checking ? (
              <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Checking invite…
              </div>
            ) : invalid ? (
              (() => {
                const copy = INVALID_COPY[invalid] ?? INVALID_COPY.not_found;
                const Icon = copy.icon;
                return (
                  <Alert className="border-destructive/40 bg-destructive/5">
                    <Icon className="h-4 w-4 text-destructive" />
                    <AlertTitle className="font-mono text-sm">{copy.title}</AlertTitle>
                    <AlertDescription className="space-y-3 text-xs text-muted-foreground">
                      <p>{copy.body}</p>
                      <Button asChild size="sm" variant="secondary">
                        <Link to="/auth">Go to sign in</Link>
                      </Button>
                    </AlertDescription>
                  </Alert>
                );
              })()
            ) : invite ? (
              <>
                <div className="mb-4 flex flex-wrap items-center gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-muted-foreground">
                  <span>
                    {invite.invited_by_name ? (
                      <>
                        Invited by{" "}
                        <span className="font-medium text-foreground">
                          {invite.invited_by_name}
                        </span>
                      </>
                    ) : (
                      "You were invited"
                    )}{" "}
                    to join as
                  </span>
                  <Badge variant="secondary" className="font-mono text-[10px]">
                    {ROLE_LABELS[invite.role] ?? invite.role}
                  </Badge>
                </div>
                {session && (
                  <Alert className="mb-4 border-warning/40 bg-warning/5">
                    <AlertDescription className="text-xs text-muted-foreground">
                      You're already signed in. Accepting this invite creates a separate new
                      account.
                    </AlertDescription>
                  </Alert>
                )}
                <Form {...form}>
                  <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                    <FormField
                      control={form.control}
                      name="displayName"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Display name</FormLabel>
                          <FormControl>
                            <Input autoComplete="name" autoFocus {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="email"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>
                            Email{" "}
                            {emailLocked && (
                              <span className="font-normal text-muted-foreground">
                                (locked to this invite)
                              </span>
                            )}
                          </FormLabel>
                          <FormControl>
                            <Input
                              type="email"
                              autoComplete="email"
                              readOnly={emailLocked}
                              className={emailLocked ? "opacity-70" : undefined}
                              {...field}
                            />
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
                          <FormLabel>Password</FormLabel>
                          <FormControl>
                            <Input type="password" autoComplete="new-password" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="confirm"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Confirm password</FormLabel>
                          <FormControl>
                            <Input type="password" autoComplete="new-password" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <Button type="submit" className="w-full" disabled={busy}>
                      {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      {busy ? "Creating account…" : "Create account"}
                    </Button>
                  </form>
                </Form>
              </>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
