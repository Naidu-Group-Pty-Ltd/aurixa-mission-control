// Blacklisted numbers — the kill list. A live inbound call from an active
// entry is terminated by the webhook (silent, or after an announcement).
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RecordRow } from "@/components/record-row";
import { EmptyState } from "@/components/empty-state";
import { useConfirm } from "@/components/confirm-dialog";
import { deleteBlacklistEntry, listBlacklist, upsertBlacklistEntry } from "@/lib/voice.functions";
import { MonoStatus } from "@/components/voice/tone";
import { ShieldBan, Trash2 } from "lucide-react";

const CATEGORIES = ["spam", "scam", "telemarketer", "abusive", "other"] as const;

export function BlacklistPanel() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const q = useQuery({
    queryKey: ["voice", "blacklist"],
    queryFn: () => listBlacklist({ data: {} }),
  });

  const [open, setOpen] = useState(false);
  const [phone, setPhone] = useState("");
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]>("spam");
  const [killMode, setKillMode] = useState<"silent" | "announce">("silent");
  const [announce, setAnnounce] = useState("");
  const [notes, setNotes] = useState("");

  const save = useMutation({
    mutationFn: () =>
      upsertBlacklistEntry({
        data: {
          phoneNumber: phone,
          category,
          killMode,
          announceMessage: killMode === "announce" ? announce || null : null,
          notes: notes || null,
        },
      }),
    onSuccess: () => {
      toast.success("Number blacklisted");
      setOpen(false);
      setPhone("");
      setAnnounce("");
      setNotes("");
      qc.invalidateQueries({ queryKey: ["voice", "blacklist"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const toggle = useMutation({
    mutationFn: (entry: {
      id: string;
      phone_number: string;
      category: string;
      kill_mode: string;
      announce_message: string | null;
      notes: string | null;
      is_active: boolean;
    }) =>
      upsertBlacklistEntry({
        data: {
          id: entry.id,
          phoneNumber: entry.phone_number,
          category: entry.category as (typeof CATEGORIES)[number],
          killMode: entry.kill_mode as "silent" | "announce",
          announceMessage: entry.announce_message,
          notes: entry.notes,
          isActive: !entry.is_active,
        },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["voice", "blacklist"] }),
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteBlacklistEntry({ data: { id } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["voice", "blacklist"] }),
    onError: (e: Error) => toast.error(e.message),
  });

  const rows = q.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button>
              <ShieldBan className="mr-2 h-4 w-4" /> Blacklist a number
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Blacklist a number</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <Input placeholder="+61…" value={phone} onChange={(e) => setPhone(e.target.value)} />
              <div className="flex gap-2">
                <Select value={category} onValueChange={(v) => setCategory(v as never)}>
                  <SelectTrigger className="flex-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CATEGORIES.map((c) => (
                      <SelectItem key={c} value={c}>
                        {c}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={killMode} onValueChange={(v) => setKillMode(v as never)}>
                  <SelectTrigger className="flex-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="silent">kill silently</SelectItem>
                    <SelectItem value="announce">announce, then kill</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {killMode === "announce" && (
                <Textarea
                  placeholder="Announcement (max 300 chars)"
                  maxLength={300}
                  value={announce}
                  onChange={(e) => setAnnounce(e.target.value)}
                />
              )}
              <Textarea
                placeholder="Notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
              <Button
                className="w-full"
                disabled={!phone.trim() || save.isPending}
                onClick={() => save.mutate()}
              >
                Add to blacklist
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {!q.isLoading && rows.length === 0 && (
        <EmptyState
          icon={<ShieldBan className="h-6 w-6" />}
          title="No blacklisted numbers"
          description="Numbers added here have their inbound calls terminated automatically."
        />
      )}

      <div className="space-y-2">
        {rows.map((entry) => (
          <RecordRow
            key={entry.id}
            spine={entry.is_active ? "bad" : "idle"}
            className="flex items-center gap-3 px-4 py-3"
          >
            <div className="min-w-0 flex-1">
              <p className="font-mono text-sm">{entry.phone_number}</p>
              <p className="truncate text-xs text-muted-foreground">
                {entry.category} · {entry.kill_mode}
                {entry.notes && ` · ${entry.notes}`}
              </p>
            </div>
            <MonoStatus
              label={`${entry.hit_count} hit${entry.hit_count === 1 ? "" : "s"}`}
              tone={entry.hit_count > 0 ? "warning" : "neutral"}
            />
            {entry.last_hit_at && (
              <span className="hidden font-mono text-xs text-muted-foreground sm:inline">
                {formatDistanceToNow(new Date(entry.last_hit_at), { addSuffix: true })}
              </span>
            )}
            <Switch
              checked={entry.is_active}
              onCheckedChange={() => toggle.mutate(entry)}
              aria-label="Active"
            />
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                if (
                  await confirm({
                    title: `Remove ${entry.phone_number} from the blacklist?`,
                    confirmText: "Remove",
                  })
                ) {
                  remove.mutate(entry.id);
                }
              }}
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          </RecordRow>
        ))}
      </div>
    </div>
  );
}
