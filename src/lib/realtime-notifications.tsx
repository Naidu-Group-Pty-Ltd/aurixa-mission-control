import { useEffect, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { getMutedSnapshot, isMuted } from "@/lib/notification-preferences";
import type { Database } from "@/integrations/supabase/types";

type CascadeEvent = Database["public"]["Tables"]["cascade_events"]["Row"];
type Clone = Database["public"]["Tables"]["clones"]["Row"];

type DriftSuggestion = {
  severity: "low" | "medium" | "high";
  title: string;
  rationale: string;
  recommended_action: string;
};

const TERMINAL_STATUSES = new Set(["completed", "failed", "partial"]);

/**
 * App-wide realtime notifier. Subscribes to cascade_events and clones and
 * surfaces toasts for cascade outcomes and new high-severity drift findings,
 * regardless of which page the operator is on.
 */
export function RealtimeNotifications() {
  const { session } = useAuth();
  const navigate = useNavigate();
  // Track which (clone_id, suggestion_title) pairs we've already alerted on
  // to avoid re-toasting the same finding on every re-render or scan.
  const seenHighDrift = useRef<Set<string>>(new Set());
  // Track terminal cascade events we've already announced.
  const seenTerminalEvents = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!session) return;

    // Seed: fetch current high-severity drift so we don't fire on first load.
    void supabase
      .from("clones")
      .select("id, drift_suggestions")
      .then(({ data }) => {
        for (const c of data ?? []) {
          const sugg = (c.drift_suggestions as DriftSuggestion[] | null) ?? [];
          for (const s of sugg) {
            if (s.severity === "high") {
              seenHighDrift.current.add(`${c.id}::${s.title}`);
            }
          }
        }
      });

    const channelSuffix = Math.random().toString(36).slice(2);
    const cascadeChannel = supabase
      .channel(`notif:cascade_events:${channelSuffix}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "cascade_events" },
        (payload) => {
          const ev = payload.new as CascadeEvent;
          const prev = payload.old as Partial<CascadeEvent>;
          if (!TERMINAL_STATUSES.has(ev.status)) return;
          if (prev.status === ev.status) return;
          if (seenTerminalEvents.current.has(ev.id)) return;
          seenTerminalEvents.current.add(ev.id);

          const open = () => navigate({ to: "/cascades/$eventId", params: { eventId: ev.id } });

          // Honor user mute preferences for toasts.
          const snap = getMutedSnapshot();
          if (snap.mute_toasts) return;

          if (ev.status === "completed") {
            if (isMuted(snap, "cascade_completed", "success")) return;
            toast.success(`Cascade completed (${ev.mode})`, {
              description: ev.summary ?? "All targeted clones synced.",
              action: { label: "View", onClick: open },
            });
          } else if (ev.status === "failed") {
            if (isMuted(snap, "cascade_failed", "error")) return;
            toast.error(`Cascade failed (${ev.mode})`, {
              description: ev.summary ?? "Cascade run did not succeed.",
              action: { label: "View", onClick: open },
            });
          } else {
            if (isMuted(snap, "cascade_partial", "warning")) return;
            toast.warning(`Cascade partial (${ev.mode})`, {
              description: ev.summary ?? "Some clones failed to sync.",
              action: { label: "View", onClick: open },
            });
          }
        },
      )
      .subscribe();

    const clonesChannel = supabase
      .channel(`notif:clones-drift:${channelSuffix}`)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "clones" }, (payload) => {
        const c = payload.new as Clone;
        const sugg = (c.drift_suggestions as DriftSuggestion[] | null) ?? [];
        const fresh: DriftSuggestion[] = [];
        for (const s of sugg) {
          if (s.severity !== "high") continue;
          const key = `${c.id}::${s.title}`;
          if (seenHighDrift.current.has(key)) continue;
          seenHighDrift.current.add(key);
          fresh.push(s);
        }
        if (fresh.length === 0) return;

        // Honor mute preferences for high-drift toasts.
        const snap = getMutedSnapshot();
        if (snap.mute_toasts) return;
        if (isMuted(snap, "drift_high", "warning")) return;

        const goto = () => navigate({ to: "/fleet-manager" });
        const first = fresh[0];
        toast.warning(
          fresh.length === 1
            ? `High drift on ${c.name}`
            : `${fresh.length} high-severity issues on ${c.name}`,
          {
            description: first.title,
            action: { label: "Inspect", onClick: goto },
            duration: 8000,
          },
        );
      })
      .subscribe();

    return () => {
      void supabase.removeChannel(cascadeChannel);
      void supabase.removeChannel(clonesChannel);
    };
  }, [session, navigate]);

  return null;
}
