import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { operatorDisplayName, recordAdminAction } from "@/server/purchases.server";

// ─── Plan catalog ────────────────────────────────────────────────────

export const listSeatPlans = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("seat_plans" as never)
      .select("*")
      .order("price_cents", { ascending: true });
    if (error) throw new Error(error.message);
    return { plans: (data ?? []) as any[] };
  });

// ─── Entitlements + usage rollup for MC dashboard ────────────────────

export const listSeatEntitlements = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const [ents, plans, clones] = await Promise.all([
      context.supabase.from("clone_seat_entitlements" as never).select("*"),
      context.supabase.from("seat_plans" as never).select("*"),
      context.supabase.from("clones").select("id, name, slug"),
    ]);
    if (ents.error) throw new Error(ents.error.message);
    if (plans.error) throw new Error(plans.error.message);
    const planMap = new Map<string, any>((plans.data ?? []).map((p: any) => [p.id, p]));
    const cloneMap = new Map<string, any>((clones.data ?? []).map((c) => [c.id, c]));
    const rows = ((ents.data ?? []) as any[]).map((e) => ({
      ...e,
      plan: planMap.get(e.seat_plan_id) ?? null,
      clone: e.clone_id ? (cloneMap.get(e.clone_id) ?? null) : null,
    }));
    return { entitlements: rows };
  });

// ─── Assign / change plan ────────────────────────────────────────────

export const assignSeatPlan = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        cloneId: z.string().uuid().nullable(),
        seatPlanId: z.string().uuid(),
        notes: z.string().max(500).optional().nullable(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const filter = data.cloneId
      ? supabase
          .from("clone_seat_entitlements" as never)
          .select("*")
          .eq("clone_id", data.cloneId)
          .maybeSingle()
      : supabase
          .from("clone_seat_entitlements" as never)
          .select("*")
          .is("clone_id", null)
          .maybeSingle();
    const existing = await filter;
    const prevPlanId = (existing.data as any)?.seat_plan_id ?? null;

    let row: any;
    if (existing.data) {
      const upd = await supabase
        .from("clone_seat_entitlements" as never)
        .update({ seat_plan_id: data.seatPlanId, notes: data.notes ?? null } as never)
        .eq("id", (existing.data as any).id)
        .select("*")
        .single();
      if (upd.error) throw new Error(upd.error.message);
      row = upd.data;
    } else {
      const ins = await supabase
        .from("clone_seat_entitlements" as never)
        .insert({
          clone_id: data.cloneId,
          seat_plan_id: data.seatPlanId,
          notes: data.notes ?? null,
        } as never)
        .select("*")
        .single();
      if (ins.error) throw new Error(ins.error.message);
      row = ins.data;
    }

    await supabase.from("seat_audit" as never).insert({
      clone_id: data.cloneId,
      action: "plan_change",
      actor_user_id: userId,
      metadata: { from: prevPlanId, to: data.seatPlanId, notes: data.notes ?? null },
    } as never);

    await supabase.from("notifications").insert({
      kind: "seat_plan_changed" as any,
      severity: "info",
      title: data.cloneId ? "Seat plan changed" : "Prime seat plan changed",
      body: `Plan switched to ${data.seatPlanId.slice(0, 8)}…`,
      clone_id: data.cloneId,
      url: "/settings/billing",
      metadata: { from: prevPlanId, to: data.seatPlanId } as any,
    });

    // Discretionary-action oversight (user-attributed pricing workflow):
    // manual seat-plan changes land in the purchases ledger alongside
    // customer checkouts.
    void recordAdminAction({
      mode: "admin_seat_change",
      cloneId: data.cloneId,
      itemSlug: `seat_plan:${data.seatPlanId}`,
      operatorUserId: userId as string,
      operatorUsername: await operatorDisplayName(userId as string),
      metadata: { from: prevPlanId, to: data.seatPlanId, notes: data.notes ?? null },
    });

    return { ok: true as const, entitlement: row };
  });

// ─── Seat listing per clone (MC admin view) ──────────────────────────

export const listClonesSeats = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        cloneId: z.string().uuid().nullable().optional(),
        limit: z.number().int().min(1).max(500).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    let q = context.supabase
      .from("clone_seats" as never)
      .select("*")
      .neq("status", "removed")
      .order("created_at", { ascending: false })
      .limit(data.limit ?? 200);
    if (data.cloneId === null) q = q.is("clone_id", null);
    else if (data.cloneId) q = q.eq("clone_id", data.cloneId);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return { seats: (rows ?? []) as any[] };
  });

// ─── Manual remove from MC ───────────────────────────────────────────

export const removeSeatManually = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z.object({ seatId: z.string().uuid(), reason: z.string().max(500).optional() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const seat = await supabase
      .from("clone_seats" as never)
      .select("*")
      .eq("id", data.seatId)
      .maybeSingle();
    if (seat.error || !seat.data)
      return { ok: false as const, error: seat.error?.message ?? "not_found" };
    const upd = await supabase
      .from("clone_seats" as never)
      .update({ status: "removed", removed_at: new Date().toISOString() } as never)
      .eq("id", data.seatId);
    if (upd.error) return { ok: false as const, error: upd.error.message };
    await supabase.rpc(
      "recompute_seats_used" as never,
      { _clone_id: (seat.data as any).clone_id } as never,
    );
    await supabase.from("seat_audit" as never).insert({
      clone_id: (seat.data as any).clone_id,
      action: "manual_remove",
      external_user_id: (seat.data as any).external_user_id,
      seat_id: data.seatId,
      actor_user_id: userId,
      metadata: { reason: data.reason ?? null },
    } as never);
    return { ok: true as const };
  });

// ─── Audit feed ──────────────────────────────────────────────────────

export const listSeatAudit = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        cloneId: z.string().uuid().nullable().optional(),
        limit: z.number().int().min(1).max(500).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    let q = context.supabase
      .from("seat_audit" as never)
      .select("*")
      .order("created_at", { ascending: false })
      .limit(data.limit ?? 100);
    if (data.cloneId === null) q = q.is("clone_id", null);
    else if (data.cloneId) q = q.eq("clone_id", data.cloneId);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return { entries: (rows ?? []) as any[] };
  });
