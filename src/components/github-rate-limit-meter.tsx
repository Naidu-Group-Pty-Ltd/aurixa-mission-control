// Small GitHub App rate-limit meter shown in the desktop topbar.
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { getGitHubRateLimit } from "@/server/github-rate-limit.functions";
import { Github } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

type State = { remaining: number; limit: number; reset: number } | null;

export function GitHubRateLimitMeter() {
  const fn = useServerFn(getGitHubRateLimit);
  const [state, setState] = useState<State>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fn();
        if (cancelled) return;
        if (r.ok) {
          setState({ remaining: r.remaining, limit: r.limit, reset: r.reset });
          setErr(null);
        } else {
          setErr(r.error);
        }
      } catch (e) {
        setErr(e instanceof Error ? e.message : "unknown");
      }
    };
    void tick();
    const id = setInterval(() => void tick(), 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [fn]);

  if (err) return null;
  if (!state) return null;
  const pct = state.limit > 0 ? state.remaining / state.limit : 1;
  const tone = pct > 0.5 ? "text-emerald-500" : pct > 0.2 ? "text-amber-500" : "text-red-500";
  const resetMin = Math.max(0, Math.round((state.reset * 1000 - Date.now()) / 60000));
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex items-center gap-1.5 border bg-surface px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
          <Github className={cn("h-3 w-3", tone)} />
          <span className={cn(tone)}>{state.remaining.toLocaleString()}</span>
          <span className="text-muted-foreground/60">/ {state.limit.toLocaleString()}</span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom">GitHub App rate limit · resets in {resetMin}m</TooltipContent>
    </Tooltip>
  );
}
