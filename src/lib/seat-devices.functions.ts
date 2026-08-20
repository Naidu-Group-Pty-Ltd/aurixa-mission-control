import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const listSeatDevices = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        cloneId: z.string().uuid().nullable().optional(),
        externalUserId: z.string().optional(),
        status: z.enum(["active", "revoked", "all"]).optional(),
        limit: z.number().int().min(1).max(500).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    let q = context.supabase
      .from("clone_seat_devices" as never)
      .select("*")
      .order("last_seen_at", { ascending: false })
      .limit(data.limit ?? 200);
    if (data.cloneId === null) q = q.is("clone_id", null);
    else if (data.cloneId) q = q.eq("clone_id", data.cloneId);
    if (data.externalUserId) q = q.eq("external_user_id", data.externalUserId);
    const status = data.status ?? "active";
    if (status !== "all") q = q.eq("status", status);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return { devices: (rows ?? []) as any[] };
  });

export const revokeSeatDevice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z.object({ deviceId: z.string().uuid(), reason: z.string().max(500).optional() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { data: result, error } = await context.supabase.rpc(
      "release_device" as never,
      {
        _device_id: data.deviceId,
        _clone_id: null,
        _external_user_id: null,
        _device_fingerprint: null,
        _reason: data.reason ?? "manual_mc_revoke",
      } as never,
    );
    if (error) return { ok: false as const, error: error.message };
    return { ok: true as const, result: result as any };
  });

export const seatDeviceSummary = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("clone_seat_devices" as never)
      .select("clone_id, status");
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as any[];
    const byClone = new Map<string | null, { active: number; revoked: number }>();
    for (const r of rows) {
      const k = r.clone_id ?? null;
      const cur = byClone.get(k) ?? { active: 0, revoked: 0 };
      if (r.status === "active") cur.active += 1;
      else cur.revoked += 1;
      byClone.set(k, cur);
    }
    return {
      total_active: rows.filter((r) => r.status === "active").length,
      total_revoked: rows.filter((r) => r.status === "revoked").length,
      per_clone: Array.from(byClone.entries()).map(([clone_id, counts]) => ({
        clone_id,
        ...counts,
      })),
    };
  });
