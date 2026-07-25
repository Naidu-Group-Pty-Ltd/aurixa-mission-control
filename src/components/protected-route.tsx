import { useEffect, useState } from "react";
import { useNavigate, useLocation } from "@tanstack/react-router";
import { useAuth } from "@/lib/auth";
import { supabase } from "@/integrations/supabase/client";
import { ROLE_LEVELS, highestLevel, type RoleName } from "@/integrations/supabase/roles";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { AlertTriangle, RefreshCw } from "lucide-react";

export function ProtectedRoute({
  children,
  requireRole,
}: {
  children: React.ReactNode;
  /**
   * If set, the signed-in user's highest tier must meet or exceed this role's
   * level to view the page — otherwise they see an access-denied panel. The
   * check is hierarchy-aware: requireRole="admin" admits super_admin and the
   * High King too. When omitted, any role grants access.
   */
  requireRole?: RoleName;
}) {
  const { session, loading } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const [roles, setRoles] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (loading) return;
    if (!session) {
      // Preserve where the user was headed so auth.tsx can send them back
      // after they sign in (it already honours a `redirect` search param).
      const redirect = loc.pathname + (loc.searchStr ?? "");

      // search typing collapses to `never` under this project's loose tsconfig;
      // the value is validated by /auth's validateSearch at runtime.
      nav({ to: "/auth", search: { redirect } as any });
      return;
    }
    let cancelled = false;
    setError(null);
    setRoles(null);
    void (async () => {
      const { data, error: qErr } = await supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", session.user.id);
      if (cancelled) return;
      if (qErr) {
        // Surface the failure instead of hanging on "authenticating…" forever.
        setError(qErr.message);
        return;
      }
      setRoles((data ?? []).map((r) => r.role as string));
    })();
    return () => {
      cancelled = true;
    };
  }, [session, loading, nav, loc.pathname, loc.searchStr, nonce]);

  if (loading || (session && roles === null && !error)) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <div className="font-mono text-sm text-muted-foreground">authenticating…</div>
      </div>
    );
  }

  if (!session) return null;

  if (error) {
    return (
      <div className="flex min-h-dvh items-center justify-center p-6">
        <div className="max-w-md rounded-lg border border-border bg-card p-6 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10 ring-1 ring-destructive/30">
            <AlertTriangle className="h-6 w-6 text-destructive" />
          </div>
          <h2 className="font-mono text-lg font-semibold">Couldn't verify access</h2>
          <p className="mt-2 text-sm text-muted-foreground">{error}</p>
          <Button className="mt-4" variant="outline" onClick={() => setNonce((n) => n + 1)}>
            <RefreshCw className="mr-1.5 h-4 w-4" /> Retry
          </Button>
        </div>
      </div>
    );
  }

  const hasAnyRole = (roles?.length ?? 0) > 0;
  if (!hasAnyRole) {
    return (
      <div className="flex min-h-dvh items-center justify-center p-6">
        <div className="max-w-md rounded-lg border border-border bg-card p-6 text-center">
          <h2 className="font-mono text-lg font-semibold">Access denied</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Your account has no operator role assigned. Ask an admin to grant access.
          </p>
        </div>
      </div>
    );
  }

  if (requireRole && highestLevel(roles ?? []) < ROLE_LEVELS[requireRole]) {
    return (
      <div className="flex min-h-dvh items-center justify-center p-6">
        <div className="max-w-md rounded-lg border border-border bg-card p-6 text-center">
          <h2 className="font-mono text-lg font-semibold">Access denied</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            This area requires the <span className="font-mono text-foreground">{requireRole}</span>{" "}
            role. Ask an admin to grant it.
          </p>
        </div>
      </div>
    );
  }

  return <AppShell>{children}</AppShell>;
}
