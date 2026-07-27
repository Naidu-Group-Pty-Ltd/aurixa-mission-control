// @ts-nocheck
import { useQuery } from "@tanstack/react-query";
import { listCloneCodexOverview } from "@/lib/codex-security.functions";

/**
 * Fleet-wide security posture summary, cached and shared across the app.
 * Powers the sidebar severity dot on "Security Overview" and the dashboard
 * security tile so both surfaces stay in lock-step without duplicate fetches.
 */
export function useFleetSecurityBadge() {
  const q = useQuery({
    queryKey: ["clone-codex-overview"],
    queryFn: () => listCloneCodexOverview(),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const clones = q.data?.clones ?? [];
  const totals = clones.reduce(
    (acc, c) => {
      const f = c.openFindings ?? {};
      acc.critical += f.critical ?? 0;
      acc.high += f.high ?? 0;
      acc.medium += f.medium ?? 0;
      acc.low += f.low ?? 0;
      acc.info += f.info ?? 0;
      return acc;
    },
    { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
  );
  const hotClones = clones.filter(
    (c) => (c.openFindings?.critical ?? 0) + (c.openFindings?.high ?? 0) > 0,
  ).length;

  return {
    isLoading: q.isLoading,
    totals,
    hotClones,
    fleetSize: clones.length,
  };
}
