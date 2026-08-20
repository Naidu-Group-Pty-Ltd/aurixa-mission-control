// Phase 10 — Brand version diff dialog
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { GitCompare, Loader2 } from "lucide-react";
import { diffBrandVersions } from "@/server/operator-ux.functions";
import { listBrandVersions } from "@/server/branding-extensions.functions";

export function BrandDiffDialog({ profileId }: { profileId: string }) {
  const [open, setOpen] = useState(false);
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const versionsFn = useServerFn(listBrandVersions);
  const diffFn = useServerFn(diffBrandVersions);

  const versionsQ = useQuery({
    queryKey: ["brand-versions", profileId],
    queryFn: () => versionsFn({ data: { profileId } }),
    enabled: open,
  });
  const diffQ = useQuery({
    queryKey: ["brand-diff", profileId, a, b],
    queryFn: () => diffFn({ data: { profileId, versionA: a, versionB: b } }),
    enabled: !!a && !!b && a !== b,
  });

  const versions = versionsQ.data?.ok ? versionsQ.data.versions : [];
  const diff = diffQ.data?.ok ? diffQ.data.diff : [];

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <GitCompare className="mr-2 h-4 w-4" /> Compare versions
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Brand version diff</DialogTitle>
          <DialogDescription>
            Pick two snapshots to inspect the configuration delta.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <VersionPicker label="From (A)" value={a} onChange={setA} versions={versions} />
          <VersionPicker label="To (B)" value={b} onChange={setB} versions={versions} />
        </div>
        {diffQ.isFetching && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Computing diff…
          </div>
        )}
        {a &&
          b &&
          a !== b &&
          diffQ.data?.ok &&
          (diff.length === 0 ? (
            <p className="border border-dashed p-4 text-center text-sm text-muted-foreground">
              No differences between these versions.
            </p>
          ) : (
            <div className="space-y-1.5 font-mono text-xs">
              {diff.map((d, i) => (
                <div key={i} className="border border-border bg-surface p-2">
                  <div className="flex items-center gap-2">
                    <Badge
                      variant="outline"
                      className={
                        d.kind === "added"
                          ? "border-success/40 text-success"
                          : d.kind === "removed"
                            ? "border-destructive/40 text-destructive"
                            : "border-warning/40 text-warning"
                      }
                    >
                      {d.kind}
                    </Badge>
                    <span className="truncate">{d.path}</span>
                  </div>
                  {d.kind !== "added" && d.before !== null && (
                    <pre className="mt-1 whitespace-pre-wrap break-all bg-destructive/5 p-2 text-destructive">
                      - {d.before as string}
                    </pre>
                  )}
                  {d.kind !== "removed" && d.after !== null && (
                    <pre className="mt-1 whitespace-pre-wrap break-all bg-success/5 p-2 text-success">
                      + {d.after as string}
                    </pre>
                  )}
                </div>
              ))}
            </div>
          ))}
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function VersionPicker({
  label,
  value,
  onChange,
  versions,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  versions: { id: string; version: number; published_at: string }[];
}) {
  return (
    <div>
      <label className="font-mono text-[11px] uppercase text-muted-foreground">{label}</label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger>
          <SelectValue placeholder="Pick a version" />
        </SelectTrigger>
        <SelectContent>
          {versions.map((v) => (
            <SelectItem key={v.id} value={v.id}>
              v{v.version} · {new Date(v.published_at).toLocaleDateString()}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
