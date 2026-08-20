// First-run onboarding wizard — a guided, multi-step setup tour.
//
// Behaviour:
//  - Auto-opens ONCE per browser session for a fresh operator (no clones yet),
//    unless it has been explicitly finished/skipped (persistent flag).
//  - Stepping through the tour and opening a step's destination is
//    non-destructive: it never permanently dismisses onboarding, so the guide
//    is still available next session (or via the ⌘K "Setup guide" command).
//  - Only an explicit Finish or Skip writes the persistent flag.
//  - Re-openable any time by dispatching a global "open-onboarding" event.
import { useCallback, useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  CheckCircle2,
  GitFork,
  Boxes,
  Palette,
  Bell,
  Sparkles,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  PartyPopper,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useClones } from "@/lib/queries";

// Persistent flag: set only when the operator explicitly finishes or skips.
const KEY = "mc:onboarded:v1";
// Per-session flag: prevents the guide from re-popping on every navigation
// within a session while still allowing it to return in a later session.
const SESSION_KEY = "mc:onboarding-shown:v1";
// Global event other surfaces (e.g. the command palette) fire to re-open the guide.
export const OPEN_ONBOARDING_EVENT = "open-onboarding";

type Step = {
  icon: LucideIcon;
  title: string;
  desc: string;
  to: "/clones/new" | "/modules" | "/branding" | "/settings/notifications";
  cta: string;
};

const STEPS: Step[] = [
  {
    icon: GitFork,
    title: "Provision your first clone",
    desc: "Fork, template, or clone an existing repo. Mission Control wires up backend, branding, and webhooks automatically.",
    to: "/clones/new",
    cta: "Provision a clone",
  },
  {
    icon: Boxes,
    title: "Detect modules",
    desc: "Run AI module detection to map your codebase, then curate modules to make them reusable across the fleet.",
    to: "/modules",
    cta: "Open modules",
  },
  {
    icon: Palette,
    title: "Set a brand profile",
    desc: "Define a default brand profile so every new clone inherits a consistent identity from day one.",
    to: "/branding",
    cta: "Open branding",
  },
  {
    icon: Bell,
    title: "Tune notifications",
    desc: "Pick what pings you in real time versus what rolls up into the daily or weekly digest.",
    to: "/settings/notifications",
    cta: "Open notifications",
  },
];

function persistDismissed() {
  try {
    window.localStorage.setItem(KEY, new Date().toISOString());
  } catch {
    /* ignore — private mode / storage disabled */
  }
}

export function OnboardingWizard() {
  const { data: clones, loading } = useClones();
  const [open, setOpen] = useState(false);
  // step in 0..STEPS.length-1 walks the tour; STEPS.length is the "all set" screen.
  const [step, setStep] = useState(0);

  // Auto-open once per session for a fresh, never-dismissed operator.
  useEffect(() => {
    if (loading) return;
    if (typeof window === "undefined") return;
    const dismissed = window.localStorage.getItem(KEY);
    const shownThisSession = window.sessionStorage.getItem(SESSION_KEY);
    if (!dismissed && !shownThisSession && clones.length === 0) {
      try {
        window.sessionStorage.setItem(SESSION_KEY, "1");
      } catch {
        /* ignore */
      }
      setStep(0);
      setOpen(true);
    }
  }, [clones.length, loading]);

  // Allow any surface to re-open the guide via a global event.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onOpen = () => {
      setStep(0);
      setOpen(true);
    };
    window.addEventListener(OPEN_ONBOARDING_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_ONBOARDING_EVENT, onOpen);
  }, []);

  // Closing via the X / escape / backdrop is non-destructive — it does not mark
  // onboarding as done, so the guide remains available later.
  const handleOpenChange = useCallback((next: boolean) => {
    setOpen(next);
  }, []);

  const skip = useCallback(() => {
    persistDismissed();
    setOpen(false);
  }, []);

  const finish = useCallback(() => {
    persistDismissed();
    setOpen(false);
  }, []);

  const total = STEPS.length;
  const onSummary = step >= total;
  const current = onSummary ? null : STEPS[step];
  const progress = Math.round((Math.min(step, total) / total) * 100);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" /> Welcome to Mission Control
          </DialogTitle>
          <DialogDescription>
            A quick guided setup for your fleet. You can revisit any step later — nothing is locked
            in.
          </DialogDescription>
        </DialogHeader>

        {/* Progress: bar + step dots */}
        <div className="space-y-2">
          <Progress value={onSummary ? 100 : progress} />
          <div className="flex items-center justify-between">
            <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              {onSummary ? "Setup complete" : `Step ${step + 1} of ${total}`}
            </span>
            <div className="flex items-center gap-1.5" aria-hidden>
              {STEPS.map((_, i) => (
                <span
                  key={i}
                  className={cn(
                    "h-1.5 w-1.5 rounded-full transition-colors",
                    onSummary || i <= step ? "bg-primary" : "bg-primary/20",
                  )}
                />
              ))}
            </div>
          </div>
        </div>

        {onSummary ? (
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 ring-1 ring-primary/30">
              <PartyPopper className="h-6 w-6 text-primary" />
            </div>
            <div>
              <p className="text-sm font-semibold">You're all set</p>
              <p className="mt-1 text-xs text-muted-foreground">
                That's the tour. Reopen it any time from the command palette (&nbsp;⌘K → “Setup
                guide”&nbsp;).
              </p>
            </div>
          </div>
        ) : (
          current && (
            <div className="flex items-start gap-4 border border-border bg-surface p-4">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center bg-primary/10 ring-1 ring-primary/30">
                <current.icon className="h-5 w-5 text-primary" />
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-semibold">{current.title}</h3>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{current.desc}</p>
                <Button asChild size="sm" variant="secondary" className="mt-3">
                  {/* Opening a destination does NOT dismiss onboarding. */}
                  <Link to={current.to} onClick={() => setOpen(false)}>
                    {current.cta}
                    <ArrowUpRight className="ml-1.5 h-3.5 w-3.5" />
                  </Link>
                </Button>
              </div>
            </div>
          )
        )}

        <DialogFooter className="flex-row items-center justify-between gap-2 sm:justify-between">
          {onSummary ? (
            <>
              <Button variant="ghost" size="sm" onClick={() => setStep(total - 1)}>
                <ArrowLeft className="mr-1.5 h-4 w-4" /> Back
              </Button>
              <Button size="sm" onClick={finish}>
                <CheckCircle2 className="mr-1.5 h-4 w-4" /> Finish
              </Button>
            </>
          ) : (
            <>
              <div className="flex items-center gap-2">
                {step > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setStep((s) => Math.max(0, s - 1))}
                  >
                    <ArrowLeft className="mr-1.5 h-4 w-4" /> Back
                  </Button>
                )}
                <Button variant="ghost" size="sm" onClick={skip}>
                  Skip
                </Button>
              </div>
              <Button size="sm" onClick={() => setStep((s) => s + 1)}>
                {step === total - 1 ? "Finish tour" : "Next"}
                <ArrowRight className="ml-1.5 h-4 w-4" />
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
