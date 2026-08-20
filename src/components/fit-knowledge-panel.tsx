// The Client Fit analyst's knowledge base.
//
// The engine reads the pricing catalog live, so it always knows what Aurixa
// sells. This is where it learns everything else: who we are built for, who we
// decline, how we position, and what happened last time we sold into a shape
// like this one. Entries here are read on every analysis, and the ones marked
// pinned are read first.
//
// One thing this screen is deliberately honest about: only extracted *text*
// reaches the analyst. A PDF or Word file is stored so a claim can be traced
// back to its source, but the engine will not pretend to read a binary format —
// it would produce confident nonsense, which is worse than a gap.
import { useCallback, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { EmptyState } from "@/components/empty-state";
import { useConfirm } from "@/components/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  KNOWLEDGE_BUCKET,
  KNOWLEDGE_KINDS,
  KNOWLEDGE_KIND_HINTS,
  KNOWLEDGE_KIND_LABELS,
  MAX_KNOWLEDGE_CONTENT,
  TEXT_EXTRACTABLE_MIME,
  deleteFitKnowledge,
  getFitKnowledge,
  getFitKnowledgeCoverage,
  getFitKnowledgeFileUrl,
  listFitKnowledge,
  setFitKnowledgeActive,
  upsertFitKnowledge,
} from "@/lib/fit-knowledge.functions";
import { useServerAction } from "@/lib/use-server-action";
import { formatDistanceToNow } from "@/lib/format";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  BookOpen,
  Download,
  FileText,
  Pin,
  Plus,
  Trash2,
  TriangleAlert,
  Upload,
} from "lucide-react";

const EMPTY_DRAFT = {
  id: undefined as string | undefined,
  title: "",
  kind: "icp",
  content: "",
  summary: "",
  tags: "",
  pinned: false,
  active: true,
  file_path: null as string | null,
  file_name: null as string | null,
  mime_type: null as string | null,
  size_bytes: null as number | null,
};

const isTextExtractable = (file: File) =>
  TEXT_EXTRACTABLE_MIME.includes(file.type) ||
  /\.(txt|md|markdown|csv|json|html?)$/i.test(file.name);

const prettyBytes = (bytes?: number | null) => {
  if (!bytes) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

/** Storage keys must be predictable and collision-free; names must not be trusted. */
const storagePathFor = (fileName: string) => {
  const safe = fileName.replace(/[^A-Za-z0-9._-]/g, "_").slice(-120);
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${id}/${safe}`;
};

export function FitKnowledgePanel() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [draft, setDraft] = useState<typeof EMPTY_DRAFT | null>(null);
  const [uploading, setUploading] = useState(false);
  const [kindFilter, setKindFilter] = useState("all");
  const [search, setSearch] = useState("");

  const entries = useQuery({
    queryKey: ["fit-knowledge", kindFilter, search],
    queryFn: () => listFitKnowledge({ data: { kind: kindFilter, search } }),
  });
  const coverage = useQuery({
    queryKey: ["fit-knowledge-coverage"],
    queryFn: () => getFitKnowledgeCoverage(),
  });

  const refresh = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["fit-knowledge"] });
    qc.invalidateQueries({ queryKey: ["fit-knowledge-coverage"] });
  }, [qc]);

  const save = useServerAction(upsertFitKnowledge, {
    successMessage: "Knowledge entry saved",
    onSuccess: () => {
      setDraft(null);
      refresh();
    },
  });
  const toggle = useServerAction(setFitKnowledgeActive, { onSuccess: refresh });
  const remove = useServerAction(deleteFitKnowledge, {
    successMessage: "Entry deleted",
    onSuccess: refresh,
  });

  const askDelete = async (row: any) => {
    const ok = await confirm({
      title: "Delete this knowledge entry?",
      description: `"${row.title}" and its stored document will be removed. Analyses already run keep their record of having used it.`,
      confirmText: "Delete",
      destructive: true,
    });
    if (ok) void remove.execute({ data: { id: row.id } });
  };

  const cov = coverage.data;
  const missing = cov?.missing_critical ?? [];

  const openEdit = async (row: any) => {
    try {
      const full = await getFitKnowledge({ data: { id: row.id } });
      setDraft({
        id: full.id,
        title: full.title,
        kind: full.kind,
        content: full.content ?? "",
        summary: full.summary ?? "",
        tags: (full.tags ?? []).join(", "),
        pinned: Boolean(full.pinned),
        active: Boolean(full.active),
        file_path: full.file_path,
        file_name: full.file_name,
        mime_type: full.mime_type,
        size_bytes: full.size_bytes,
      });
    } catch (err) {
      toast.error("Could not open entry", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const openFile = async (row: any) => {
    try {
      const { url } = await getFitKnowledgeFileUrl({ data: { id: row.id } });
      if (!url) {
        toast.error("No source document stored for this entry");
        return;
      }
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
      toast.error("Could not open the document", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  /**
   * Uploads the source document and, where the format allows it, reads the text
   * out of it into the draft. The file is stored either way — provenance is
   * worth keeping even when the text has to be pasted by hand.
   */
  const handleFile = async (file: File) => {
    if (!draft) return;
    setUploading(true);
    try {
      const path = storagePathFor(file.name);
      const { error } = await supabase.storage.from(KNOWLEDGE_BUCKET).upload(path, file, {
        contentType: file.type || "application/octet-stream",
        upsert: false,
      });
      if (error) throw error;

      let content = draft.content;
      let extracted = false;
      if (isTextExtractable(file)) {
        const text = await file.text();
        content = text.slice(0, MAX_KNOWLEDGE_CONTENT);
        extracted = true;
      }

      setDraft((d) =>
        d
          ? {
              ...d,
              content,
              title: d.title || file.name.replace(/\.[^.]+$/, ""),
              file_path: path,
              file_name: file.name,
              mime_type: file.type || null,
              size_bytes: file.size,
            }
          : d,
      );

      toast.success(extracted ? "Document uploaded and text extracted" : "Document uploaded", {
        description: extracted
          ? undefined
          : "This format's text cannot be read automatically — paste the relevant text below so the analyst can use it.",
      });
    } catch (err) {
      toast.error("Upload failed", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setUploading(false);
    }
  };

  const submit = () => {
    if (!draft) return;
    if (draft.title.trim().length < 2) {
      toast.error("Give the entry a title");
      return;
    }
    if (!draft.content.trim()) {
      toast.error("This entry has no text", {
        description: "An entry with no text is stored but never read by the analyst.",
      });
      return;
    }
    void save.execute({
      data: {
        id: draft.id,
        title: draft.title.trim(),
        kind: draft.kind,
        content: draft.content,
        summary: draft.summary.trim() || null,
        tags: draft.tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
        pinned: draft.pinned,
        active: draft.active,
        file_path: draft.file_path,
        file_name: draft.file_name,
        mime_type: draft.mime_type,
        size_bytes: draft.size_bytes,
      },
    });
  };

  const rows = entries.data ?? [];
  const totalChars = useMemo(() => cov?.total_chars ?? 0, [cov]);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <BookOpen className="h-4 w-4" /> Analyst knowledge base
              </CardTitle>
              <CardDescription>
                Read on every analysis, alongside the live pricing catalog. Pinned entries are
                always included; the rest compete on relevance to the prospect in front of it.
              </CardDescription>
            </div>
            <Button onClick={() => setDraft({ ...EMPTY_DRAFT })}>
              <Plus className="mr-2 h-4 w-4" /> Add entry
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Live entries" value={cov?.live} />
            <Stat label="Pinned" value={cov?.pinned} />
            <Stat
              label="Stored, unread"
              value={cov?.inert}
              hint="Files with no extracted text"
              warn={Boolean(cov?.inert)}
            />
            <Stat label="Characters in play" value={totalChars} />
          </div>

          {missing.length > 0 && (
            <div className="flex items-start gap-2 border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
              <div>
                <p className="font-medium">
                  The analyst has no{" "}
                  {missing.map((m: string) => KNOWLEDGE_KIND_LABELS[m]).join(" and no ")}.
                </p>
                <p className="text-muted-foreground">
                  Without these, segment judgements and declines fall back to the model's own
                  assumptions rather than Aurixa's policy. Both are worth pinning.
                </p>
              </div>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <Select value={kindFilter} onValueChange={setKindFilter}>
              <SelectTrigger className="w-[220px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All kinds</SelectItem>
                {KNOWLEDGE_KINDS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {KNOWLEDGE_KIND_LABELS[k]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              className="max-w-xs"
              placeholder="Search titles and summaries…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          {rows.length === 0 ? (
            <EmptyState
              icon={<BookOpen />}
              title="Nothing in the knowledge base yet"
              description="Add your ideal customer profile and your disqualification policy first — they apply to every prospect, and they are the two the engine leans on hardest."
            />
          ) : (
            <ul className="divide-y divide-border/60 border">
              {rows.map((row: any) => (
                <li key={row.id} className="flex flex-wrap items-center gap-3 p-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      {row.pinned && <Pin className="h-3 w-3 shrink-0 text-primary" />}
                      <span
                        className={cn(
                          "truncate text-sm font-medium",
                          !row.active && "text-muted-foreground line-through",
                        )}
                      >
                        {row.title}
                      </span>
                      <Badge variant="outline" className="text-[10px] uppercase">
                        {KNOWLEDGE_KIND_LABELS[row.kind] ?? row.kind}
                      </Badge>
                      {!row.has_content && (
                        <Badge
                          variant="outline"
                          className="border-amber-500/40 text-[10px] uppercase text-amber-500"
                        >
                          no text — not read
                        </Badge>
                      )}
                    </div>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {row.summary ?? `${row.content_chars.toLocaleString()} characters`}
                      {row.file_name ? ` · ${row.file_name} (${prettyBytes(row.size_bytes)})` : ""}
                      {` · updated ${formatDistanceToNow(row.updated_at)}`}
                    </p>
                    {(row.tags ?? []).length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {row.tags.map((t: string) => (
                          <Badge key={t} variant="secondary" className="text-[10px]">
                            {t}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Switch
                        checked={Boolean(row.pinned)}
                        onCheckedChange={(v) => toggle.execute({ data: { id: row.id, pinned: v } })}
                      />
                      Pin
                    </label>
                    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Switch
                        checked={Boolean(row.active)}
                        onCheckedChange={(v) => toggle.execute({ data: { id: row.id, active: v } })}
                      />
                      Active
                    </label>
                    {row.file_path && (
                      <Button variant="ghost" size="sm" onClick={() => openFile(row)}>
                        <Download className="h-3.5 w-3.5" />
                      </Button>
                    )}
                    <Button variant="outline" size="sm" onClick={() => openEdit(row)}>
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void askDelete(row)}
                      className="text-destructive"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Dialog open={Boolean(draft)} onOpenChange={(open) => !open && setDraft(null)}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{draft?.id ? "Edit knowledge entry" : "Add knowledge entry"}</DialogTitle>
            <DialogDescription>
              Only the text below reaches the analyst. Upload the source document for provenance — a
              claim in a report can then be traced back to where it came from.
            </DialogDescription>
          </DialogHeader>

          {draft && (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="k-title">Title</Label>
                  <Input
                    id="k-title"
                    value={draft.title}
                    onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                    placeholder="Ideal customer profile — buyer's agencies"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="k-kind">Kind</Label>
                  <Select value={draft.kind} onValueChange={(v) => setDraft({ ...draft, kind: v })}>
                    <SelectTrigger id="k-kind">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {KNOWLEDGE_KINDS.map((k) => (
                        <SelectItem key={k} value={k}>
                          {KNOWLEDGE_KIND_LABELS[k]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    {KNOWLEDGE_KIND_HINTS[draft.kind]}
                  </p>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="k-summary">Summary (optional)</Label>
                <Input
                  id="k-summary"
                  value={draft.summary}
                  onChange={(e) => setDraft({ ...draft, summary: e.target.value })}
                  placeholder="One line, for the list and for relevance matching"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="k-tags">Tags</Label>
                <Input
                  id="k-tags"
                  value={draft.tags}
                  onChange={(e) => setDraft({ ...draft, tags: e.target.value })}
                  placeholder="buyers agency, conveyancing, enterprise — comma separated"
                />
                <p className="text-xs text-muted-foreground">
                  Tags are matched against the prospect, so an entry about conveyancing surfaces for
                  conveyancers.
                </p>
              </div>

              <div className="space-y-1.5">
                <Label>Source document (optional)</Label>
                <div className="flex flex-wrap items-center gap-2">
                  <Button asChild variant="outline" size="sm" disabled={uploading}>
                    <label className="cursor-pointer">
                      <Upload className="mr-2 h-4 w-4" />
                      {uploading ? "Uploading…" : "Upload file"}
                      <input
                        type="file"
                        className="sr-only"
                        accept=".txt,.md,.markdown,.csv,.json,.html,.htm,.pdf,.doc,.docx,.xls,.xlsx"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) void handleFile(file);
                          e.target.value = "";
                        }}
                      />
                    </label>
                  </Button>
                  {draft.file_name && (
                    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                      <FileText className="h-3.5 w-3.5" />
                      {draft.file_name} ({prettyBytes(draft.size_bytes)})
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  Text, Markdown, CSV, JSON and HTML have their text extracted automatically. PDF,
                  Word and Excel are stored for reference, but their text has to be pasted below —
                  the engine will not guess at a binary format.
                </p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="k-content">
                  Text the analyst reads
                  <span className="ml-2 font-mono text-xs text-muted-foreground">
                    {draft.content.length.toLocaleString()} /{" "}
                    {MAX_KNOWLEDGE_CONTENT.toLocaleString()}
                  </span>
                </Label>
                <Textarea
                  id="k-content"
                  rows={12}
                  value={draft.content}
                  onChange={(e) =>
                    setDraft({ ...draft, content: e.target.value.slice(0, MAX_KNOWLEDGE_CONTENT) })
                  }
                  placeholder="Paste or write the content. Be specific — 'we decline sole traders with no ABN' is usable; 'we like good clients' is not."
                />
              </div>

              <div className="flex flex-wrap items-center gap-6">
                <label className="flex items-center gap-2 text-sm">
                  <Switch
                    checked={draft.pinned}
                    onCheckedChange={(v) => setDraft({ ...draft, pinned: v })}
                  />
                  Pin — include on every analysis
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <Switch
                    checked={draft.active}
                    onCheckedChange={(v) => setDraft({ ...draft, active: v })}
                  />
                  Active
                </label>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="ghost" onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={save.isPending || uploading}>
              {save.isPending ? "Saving…" : "Save entry"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  warn,
}: {
  label: string;
  value: number | undefined;
  hint?: string;
  warn?: boolean;
}) {
  return (
    <div className="border p-3">
      <div
        className={cn(
          "text-2xl font-semibold tabular-nums tracking-tight",
          warn && "text-amber-500",
        )}
      >
        {value === undefined ? "—" : value.toLocaleString()}
      </div>
      <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      {hint && <div className="mt-0.5 text-[11px] text-muted-foreground/80">{hint}</div>}
    </div>
  );
}
