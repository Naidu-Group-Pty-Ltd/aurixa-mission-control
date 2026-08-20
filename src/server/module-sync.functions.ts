import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { bulkSyncModule, type ModuleSyncResult } from "./module-sync.server";
import type { Database } from "@/integrations/supabase/types";

export type { ModuleSyncResult, ModuleSyncAction } from "./module-sync.server";

type CascadeMode = Database["public"]["Enums"]["cascade_mode"];

export const bulkSyncModuleFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (data: {
      moduleId: string;
      cloneIds: string[];
      action: "install" | "remove";
      cascade?: boolean;
      cascadeMode?: CascadeMode;
    }) => {
      if (!data?.moduleId || typeof data.moduleId !== "string") {
        throw new Error("moduleId required");
      }
      if (!Array.isArray(data?.cloneIds) || data.cloneIds.length === 0) {
        throw new Error("cloneIds required");
      }
      if (data.action !== "install" && data.action !== "remove") {
        throw new Error("action must be install or remove");
      }
      return data;
    },
  )
  .handler(async ({ data, context }): Promise<ModuleSyncResult> => {
    return bulkSyncModule({
      supabase: context.supabase,
      moduleId: data.moduleId,
      cloneIds: data.cloneIds,
      action: data.action,
      cascade: data.cascade ?? false,
      cascadeMode: data.cascadeMode ?? "pr",
      initiatedBy: context.userId,
    });
  });
