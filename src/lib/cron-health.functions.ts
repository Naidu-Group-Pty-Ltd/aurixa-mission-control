// Cron delivery health — "the job ran" and "the request arrived" are different
// questions. `cron.job_run_details` answers the first; `public.cron_delivery_health`
// joins it to `net._http_response` to answer the second. Admin-gated because a
// list of which workers are failing, and with what status, is operator business.
import { createServerFn } from "@tanstack/react-start";
import { requireAdmin } from "@/integrations/supabase/role-middleware";

export type CronDeliveryRow = {
  jobname: string;
  schedule: string;
  active: boolean;
  last_run_at: string | null;
  last_run_status: string | null;
  runs: number;
  last_http_status: number | null;
  last_http_error: string | null;
  /** null = no response matched in the window: unknown, not broken. */
  delivered: boolean | null;
};

export type CronDeliveryHealth = {
  sinceHours: number;
  rows: CronDeliveryRow[];
  failing: number;
  unknown: number;
  delivered: number;
  fetchedAt: string;
};

export const fetchCronDeliveryHealth = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((data: { sinceHours?: number } = {}) => ({
    sinceHours: Math.min(Math.max(Math.trunc(data?.sinceHours ?? 24), 1), 168),
  }))
  .handler(async ({ data }): Promise<CronDeliveryHealth> => {
    const { supabaseAdmin } = await import(
      /* @vite-ignore */ "@/integrations/supabase/client.server"
    );
    const { data: rows, error } = await supabaseAdmin.rpc("cron_delivery_health", {
      _since_hours: data.sinceHours,
    });
    if (error) throw new Error(`cron_delivery_health failed: ${error.message}`);

    const list = (rows ?? []) as CronDeliveryRow[];
    return {
      sinceHours: data.sinceHours,
      rows: list,
      failing: list.filter((r) => r.delivered === false).length,
      delivered: list.filter((r) => r.delivered === true).length,
      unknown: list.filter((r) => r.delivered == null).length,
      fetchedAt: new Date().toISOString(),
    };
  });
