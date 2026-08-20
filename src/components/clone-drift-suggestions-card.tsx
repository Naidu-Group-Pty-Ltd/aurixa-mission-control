import { useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import {
  Sparkles,
  Loader2,
  GitMerge,
  Send,
  Bell,
  XCircle,
  CheckCircle2,
  ExternalLink,
  AlertTriangle,
  ChevronDown,
} from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "@/lib/format";
import {
  analyzeDrift,
  applyDriftSuggestion,
  dismissDriftSuggestion,
  type DriftSuggestion,
} from "@/server/drift-suggestions.functions";

type Mode = "pr" | "auto_merge" | "notify";

export function CloneDriftSuggestionsCard({
  cloneId,
  suggestions,
  lastCheckedAt,
  onChange,
}: {
  cloneId: string;
  suggestions: DriftSuggestion[];
  lastCheckedAt: string | null;
  onChange: () => void;
}) {
  const analyzeFn = useServerFn(analyzeDrift);
  const applyFn = useServerFn(applyDriftSuggestion);
  const dismissFn = useServerFn(dismissDriftSuggestion);
  const [analyzing, setAnalyzing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const open = useMemo(() => suggestions.filter((s) => s.status === "open"), [suggestions]);
  const closed = useMemo(() => suggestions.filter((s) => s.status !== "open"), [suggestions]);

  const analyze = async () => {
    setAnalyzing(true);
    try {
      const res = await analyzeFn({ data: { cloneId } });
      if (!res.ok) {
        toast.error(res.error);
      } else if (res.suggestions.length === 0) {
        toast.success(
          res.analyzed_files === 0
            ? "No drift detected — clone is in sync with prime."
            : "AI found nothing actionable.",
        );
      } else {
        toast.success(
          `${res.suggestions.length} suggestion${res.suggestions.length === 1 ? "" : "s"} from AI`,
        );
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Analyze failed");
    } finally {
      setAnalyzing(false);
      onChange();
    }
  };

  const apply = async (suggestion: DriftSuggestion, mode: Mode) => {
    setBusyId(suggestion.id);
    try {
      const res = await applyFn({
        data: { cloneId, suggestionId: suggestion.id, mode },
      });
      if (!res.ok) {
        toast.error(res.error);
      } else {
        toast.success(`Applied · cascade ${res.cascade_event_id.slice(0, 8)}`);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Apply failed");
    } finally {
      setBusyId(null);
      onChange();
    }
  };

  const dismiss = async (suggestion: DriftSuggestion) => {
    setBusyId(suggestion.id);
    try {
      await dismissFn({ data: { cloneId, suggestionId: suggestion.id } });
      toast.success("Suggestion dismissed");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Dismiss failed");
    } finally {
      setBusyId(null);
      onChange();
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles className="h-4 w-4 text-accent" /> AI drift suggestions
          </CardTitle>
          <CardDescription className="mt-1">
            Lovable AI compares this clone&rsquo;s installed modules against prime and proposes
            one-click fixes.
            {lastCheckedAt && (
              <span className="ml-1 font-mono text-[11px]">
                · last analyzed {formatDistanceToNow(lastCheckedAt)}
              </span>
            )}
          </CardDescription>
        </div>
        <Button size="sm" onClick={analyze} disabled={analyzing}>
          {analyzing ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Sparkles className="mr-1.5 h-3.5 w-3.5" />
          )}
          {analyzing ? "Analyzing…" : open.length === 0 ? "Analyze drift" : "Re-analyze"}
        </Button>
      </CardHeader>
      <CardContent className="space-y-2">
        {open.length === 0 && closed.length === 0 && (
          <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
            No suggestions yet. Click <span className="font-mono">Analyze drift</span> to ask the AI
            for fix proposals.
          </div>
        )}
        {open.map((s) => (
          <SuggestionRow
            key={s.id}
            suggestion={s}
            busy={busyId === s.id}
            onApply={(mode) => apply(s, mode)}
            onDismiss={() => dismiss(s)}
          />
        ))}
        {closed.length > 0 && (
          <Collapsible>
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className="mt-2 flex w-full items-center gap-2 rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-left font-mono text-[11px] uppercase tracking-wider text-muted-foreground hover:bg-muted/50"
              >
                <ChevronDown className="h-3.5 w-3.5" />
                History · {closed.length} resolved
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-2 pt-2">
              {closed.map((s) => (
                <SuggestionRow
                  key={s.id}
                  suggestion={s}
                  busy={false}
                  readOnly
                  onApply={() => {}}
                  onDismiss={() => {}}
                />
              ))}
            </CollapsibleContent>
          </Collapsible>
        )}
      </CardContent>
    </Card>
  );
}

function SuggestionRow({
  suggestion,
  busy,
  readOnly,
  onApply,
  onDismiss,
}: {
  suggestion: DriftSuggestion;
  busy: boolean;
  readOnly?: boolean;
  onApply: (mode: Mode) => void;
  onDismiss: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className={cn(
        "rounded-md border bg-surface p-3",
        suggestion.status === "applied" && "border-success/30 bg-success/5",
        suggestion.status === "dismissed" && "border-border/40 opacity-70",
        suggestion.status === "open" && "border-border",
      )}
    >
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <button
          type="button"
          className="flex flex-1 items-start gap-3 text-left"
          onClick={() => setOpen((v) => !v)}
        >
          <RiskIcon risk={suggestion.risk} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{suggestion.summary}</span>
              <Badge
                variant="outline"
                className={cn("text-[10px] uppercase", riskTone(suggestion.risk))}
              >
                {suggestion.risk}
              </Badge>
              <Badge variant="outline" className="font-mono text-[10px] uppercase">
                {suggestion.category}
              </Badge>
              <Badge
                variant="outline"
                className={cn("text-[10px] uppercase", modeTone(suggestion.recommended_mode))}
              >
                {suggestion.recommended_mode.replace("_", " ")}
              </Badge>
              {suggestion.status === "applied" && (
                <Badge
                  variant="outline"
                  className="border-success/40 text-success text-[10px] uppercase"
                >
                  applied
                </Badge>
              )}
              {suggestion.status === "dismissed" && (
                <Badge variant="outline" className="text-[10px] uppercase">
                  dismissed
                </Badge>
              )}
            </div>
            <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
              {suggestion.files.slice(0, 3).join(" · ")}
              {suggestion.files.length > 3 && ` · +${suggestion.files.length - 3} more`}
            </div>
          </div>
        </button>
        {!readOnly && suggestion.status === "open" && (
          <div className="flex shrink-0 items-center gap-1">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" disabled={busy}>
                  {busy ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <ApplyIcon mode={suggestion.recommended_mode} />
                  )}
                  Apply
                  <ChevronDown className="ml-1 h-3 w-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Choose delivery mode
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => onApply("pr")}>
                  <GitMerge className="mr-2 h-3.5 w-3.5" />
                  <span className="flex-1">Open PR</span>
                  {suggestion.recommended_mode === "pr" && (
                    <span className="font-mono text-[9px] uppercase text-muted-foreground">
                      rec
                    </span>
                  )}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onApply("auto_merge")}>
                  <Send className="mr-2 h-3.5 w-3.5" />
                  <span className="flex-1">Auto-merge</span>
                  {suggestion.recommended_mode === "auto_merge" && (
                    <span className="font-mono text-[9px] uppercase text-muted-foreground">
                      rec
                    </span>
                  )}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onApply("notify")}>
                  <Bell className="mr-2 h-3.5 w-3.5" />
                  <span className="flex-1">Notify only</span>
                  {suggestion.recommended_mode === "notify" && (
                    <span className="font-mono text-[9px] uppercase text-muted-foreground">
                      rec
                    </span>
                  )}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              size="icon"
              variant="ghost"
              disabled={busy}
              onClick={onDismiss}
              className="h-8 w-8 text-muted-foreground hover:text-destructive"
              title="Dismiss this suggestion"
            >
              <XCircle className="h-4 w-4" />
            </Button>
          </div>
        )}
        {!readOnly && suggestion.status === "applied" && suggestion.applied_event_id && (
          <Link
            to="/cascades/$eventId"
            params={{ eventId: suggestion.applied_event_id }}
            className="inline-flex items-center gap-1 self-start rounded-md border border-success/40 bg-success/10 px-2 py-1 font-mono text-[11px] text-success hover:bg-success/20"
          >
            View cascade <ExternalLink className="h-3 w-3" />
          </Link>
        )}
      </div>
      {open && (
        <div className="mt-3 space-y-2 border-t border-border/60 pt-3">
          <p className="text-sm text-muted-foreground">{suggestion.rationale}</p>
          <div className="font-mono text-[11px] text-muted-foreground">
            <div className="mb-1 uppercase tracking-wider">Files ({suggestion.files.length})</div>
            <ul className="space-y-0.5">
              {suggestion.files.map((f) => (
                <li key={f}>· {f}</li>
              ))}
            </ul>
          </div>
          <div className="font-mono text-[10px] text-muted-foreground">
            prime@{suggestion.source_sha.slice(0, 7)} · suggested{" "}
            {formatDistanceToNow(suggestion.created_at)}
          </div>
        </div>
      )}
    </div>
  );
}

function RiskIcon({ risk }: { risk: DriftSuggestion["risk"] }) {
  const cls = "h-4 w-4 shrink-0 mt-0.5";
  switch (risk) {
    case "high":
      return <AlertTriangle className={cn(cls, "text-destructive")} />;
    case "medium":
      return <AlertTriangle className={cn(cls, "text-warning")} />;
    case "low":
      return <CheckCircle2 className={cn(cls, "text-success")} />;
  }
}

function ApplyIcon({ mode }: { mode: Mode }) {
  switch (mode) {
    case "pr":
      return <GitMerge className="mr-1.5 h-3.5 w-3.5" />;
    case "auto_merge":
      return <Send className="mr-1.5 h-3.5 w-3.5" />;
    case "notify":
      return <Bell className="mr-1.5 h-3.5 w-3.5" />;
  }
}

function riskTone(r: DriftSuggestion["risk"]) {
  switch (r) {
    case "high":
      return "border-destructive/40 text-destructive";
    case "medium":
      return "border-warning/40 text-warning";
    case "low":
      return "border-success/40 text-success";
  }
}

function modeTone(m: Mode) {
  switch (m) {
    case "auto_merge":
      return "border-info/40 text-info";
    case "pr":
      return "border-accent/40 text-accent";
    case "notify":
      return "border-muted text-muted-foreground";
  }
}