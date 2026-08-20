import { useEffect, useRef } from "react";
import { useRouter, Link, useLocation } from "@tanstack/react-router";
import { AlertTriangle, RefreshCw, Home } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";

/**
 * Reusable per-route error boundary. Drop into createFileRoute({ errorComponent: RouteError })
 * for routes with loaders or heavy data fetching. Also reports the error
 * to the route_errors telemetry table for the Route Errors dashboard.
 */
export function RouteError({ error, reset }: { error: Error; reset: () => void }) {
  const router = useRouter();
  const loc = useLocation();
  const reportedRef = useRef(false);

  useEffect(() => {
    if (reportedRef.current) return;
    reportedRef.current = true;
    void (async () => {
      try {
        const {
          data: { user },
        } = await supabase.auth.getUser();
        await supabase.from("route_errors").insert({
          route_path: loc.pathname,
          message: error?.message?.slice(0, 2000) ?? "Unknown error",
          stack: error?.stack?.slice(0, 8000) ?? null,
          user_agent: typeof navigator !== "undefined" ? navigator.userAgent : null,
          user_id: user?.id ?? null,
          metadata: { search: loc.search ?? null },
        });
      } catch {
        // swallow — telemetry must never crash the boundary
      }
    })();
  }, [error, loc.pathname, loc.search]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center px-4">
      <div className="max-w-md text-center">
        <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full bg-destructive/10 ring-1 ring-destructive/30">
          <AlertTriangle className="h-6 w-6 text-destructive" />
        </div>
        <h1 className="font-mono text-xl font-semibold tracking-tight">
          This screen failed to load
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Something went wrong rendering this route. The rest of the app is still working.
        </p>
        {import.meta.env.DEV && error?.message && (
          <pre className="mt-4 max-h-40 overflow-auto bg-muted p-3 text-left font-mono text-[11px] text-destructive">
            {error.message}
          </pre>
        )}
        <div className="mt-6 flex items-center justify-center gap-2">
          <Button
            size="sm"
            onClick={() => {
              router.invalidate();
              reset();
            }}
          >
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            Retry
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link to="/">
              <Home className="mr-1.5 h-3.5 w-3.5" />
              Dashboard
            </Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
