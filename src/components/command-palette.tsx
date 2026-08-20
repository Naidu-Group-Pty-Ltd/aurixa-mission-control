import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import {
  Boxes,
  GitBranch,
  Sparkles,
  Plus,
  Bell,
  Package,
  GitFork,
  History,
  GitMerge,
  Send,
  Tag,
} from "lucide-react";
import { useClones, useModules, useCascadeEvents } from "@/lib/queries";
import { formatDistanceToNow } from "@/lib/format";
import { NAV_ITEMS } from "@/lib/nav";
import { OPEN_ONBOARDING_EVENT } from "@/components/onboarding-wizard";

type Action = {
  id: string;
  label: string;
  hint?: string;
  icon: React.ReactNode;
  onSelect: () => void;
  keywords?: string;
};

/**
 * Global ⌘K / Ctrl+K command palette.
 * - Quick navigation to any clone, module, or cascade.
 * - Common actions (new clone, fire cascade, open audit log, …).
 * - Quick-fire cascade in specific modes.
 * Mounted once in AppShell so it's available on every authenticated page.
 */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const { data: clones } = useClones();
  const { data: modules } = useModules();
  const { data: events } = useCascadeEvents(15);

  // Toggle on ⌘K / Ctrl+K, or via a global "open-command-palette" event.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("open-command-palette", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("open-command-palette", onOpen);
    };
  }, []);

  const run = useCallback((fn: () => void) => {
    setOpen(false);
    // defer so the dialog finishes closing before route change
    setTimeout(fn, 10);
  }, []);

  // Collect all unique tags from fleet
  const allTags = (() => {
    const set = new Set<string>();
    for (const c of clones) for (const t of c.tags ?? []) set.add(t);
    return Array.from(set).sort();
  })();

  const actions: Action[] = [
    {
      id: "new-clone",
      label: "New clone",
      hint: "Provision a new fleet clone",
      icon: <Plus className="h-4 w-4" />,
      onSelect: () => run(() => navigate({ to: "/clones/new" })),
      keywords: "create provision fork template",
    },
    {
      id: "setup-guide",
      label: "Setup guide",
      hint: "Reopen the onboarding tour",
      icon: <Sparkles className="h-4 w-4" />,
      onSelect: () => run(() => window.dispatchEvent(new Event(OPEN_ONBOARDING_EVENT))),
      keywords: "onboarding wizard walkthrough getting started tour help",
    },
    {
      id: "fire-cascade-pr",
      label: "Fire cascade → PR mode",
      hint: "Open PRs on all clones",
      icon: <GitMerge className="h-4 w-4" />,
      onSelect: () =>
        run(() => navigate({ to: "/cascades", search: { mode: "pr", scope: "all", tags: "" } })),
      keywords: "cascade push update pull request",
    },
    {
      id: "fire-cascade-merge",
      label: "Fire cascade → Auto-merge",
      hint: "Push & merge automatically",
      icon: <Send className="h-4 w-4" />,
      onSelect: () =>
        run(() =>
          navigate({ to: "/cascades", search: { mode: "auto_merge", scope: "all", tags: "" } }),
        ),
      keywords: "cascade push auto merge",
    },
    {
      id: "fire-cascade-notify",
      label: "Fire cascade → Notify only",
      hint: "Flag drift without commits",
      icon: <Bell className="h-4 w-4" />,
      onSelect: () =>
        run(() =>
          navigate({ to: "/cascades", search: { mode: "notify", scope: "all", tags: "" } }),
        ),
      keywords: "cascade notify drift",
    },
  ];

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Jump to clone, module, cascade — or type a command…" />
      <CommandList>
        <CommandEmpty>No matches.</CommandEmpty>

        <CommandGroup heading="Actions">
          {actions.map((a) => (
            <CommandItem key={a.id} value={`${a.label} ${a.keywords ?? ""}`} onSelect={a.onSelect}>
              <span className="text-muted-foreground">{a.icon}</span>
              <span>{a.label}</span>
              {a.hint && (
                <span className="ml-auto font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  {a.hint}
                </span>
              )}
            </CommandItem>
          ))}
        </CommandGroup>

        <CommandSeparator />
        <CommandGroup heading="Navigate">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <CommandItem
                key={item.to}
                value={`go ${item.label} ${item.keywords ?? ""}`}
                onSelect={() => run(() => navigate({ to: item.to }))}
              >
                <Icon className="h-4 w-4 text-muted-foreground" />
                <span>{item.label}</span>
              </CommandItem>
            );
          })}
        </CommandGroup>

        {/* Quick tag-scoped cascade */}
        {allTags.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Cascade by tag">
              {allTags.slice(0, 15).map((tag) => {
                const count = clones.filter((c) => (c.tags ?? []).includes(tag)).length;
                return (
                  <CommandItem
                    key={`tag-${tag}`}
                    value={`tag cascade ${tag}`}
                    onSelect={() =>
                      run(() =>
                        navigate({
                          to: "/cascades",
                          search: { mode: "pr", scope: "tagged", tags: tag },
                        }),
                      )
                    }
                  >
                    <Tag className="h-4 w-4 text-muted-foreground" />
                    <span>Cascade tag: #{tag}</span>
                    <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                      {count} clone{count === 1 ? "" : "s"} · PR
                    </span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </>
        )}

        {clones.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading={`Clones · ${clones.length}`}>
              {clones.slice(0, 30).map((c) => (
                <CommandItem
                  key={c.id}
                  value={`clone ${c.name} ${c.slug} ${c.github_owner}/${c.github_repo} ${(c.tags ?? []).join(" ")}`}
                  onSelect={() =>
                    run(() => navigate({ to: "/clones/$cloneId", params: { cloneId: c.id } }))
                  }
                >
                  <GitBranch className="h-4 w-4 text-muted-foreground" />
                  <span className="truncate">{c.name}</span>
                  <span className="ml-auto truncate font-mono text-[10px] text-muted-foreground">
                    {c.sync_status}
                    {c.commits_behind ? ` · ${c.commits_behind} behind` : ""}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {modules.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading={`Modules · ${modules.length}`}>
              {modules.slice(0, 30).map((m) => (
                <CommandItem
                  key={m.id}
                  value={`module ${m.name} ${m.slug}`}
                  onSelect={() =>
                    run(() => navigate({ to: "/modules/$slug", params: { slug: m.slug } }))
                  }
                >
                  <Boxes className="h-4 w-4 text-muted-foreground" />
                  <span className="truncate">{m.name}</span>
                  <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                    {m.status}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {events.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Recent cascades">
              {events.slice(0, 10).map((e) => (
                <CommandItem
                  key={e.id}
                  value={`cascade ${e.id} ${e.mode} ${e.status} ${e.summary ?? ""}`}
                  onSelect={() =>
                    run(() => navigate({ to: "/cascades/$eventId", params: { eventId: e.id } }))
                  }
                >
                  <History className="h-4 w-4 text-muted-foreground" />
                  <span className="font-mono text-xs">
                    {e.mode.replace("_", " ")} · {e.status}
                  </span>
                  <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                    {formatDistanceToNow(e.created_at)}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        <CommandSeparator />
        <CommandGroup heading="Tip">
          <CommandItem disabled value="tip">
            <Package className="h-4 w-4 text-muted-foreground" />
            <span className="text-xs text-muted-foreground">
              Press <CommandShortcut>⌘K</CommandShortcut> anywhere to open this palette.
            </span>
          </CommandItem>
          <CommandItem disabled value="tip2">
            <GitFork className="h-4 w-4 text-muted-foreground" />
            <span className="text-xs text-muted-foreground">
              Type to filter — clones, modules, cascades, tags, and actions all match.
            </span>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
