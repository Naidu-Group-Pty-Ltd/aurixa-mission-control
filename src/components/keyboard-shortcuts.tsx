// Vim-style keyboard shortcuts: press `g` then a target key.
// Press `?` to open the cheat sheet.
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { NAV_SHORTCUTS } from "@/lib/nav";

export function KeyboardShortcuts() {
  const nav = useNavigate();
  const armed = useRef<number | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);

  useEffect(() => {
    const isTyping = (el: EventTarget | null) => {
      if (!(el instanceof HTMLElement)) return false;
      const tag = el.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTyping(e.target)) return;
      if (e.key === "?" || (e.shiftKey && e.key === "/")) {
        e.preventDefault();
        setHelpOpen((v) => !v);
        return;
      }
      if (e.key === "g") {
        if (armed.current) window.clearTimeout(armed.current);
        armed.current = window.setTimeout(() => {
          armed.current = null;
        }, 1200);
        return;
      }
      if (armed.current) {
        const target = NAV_SHORTCUTS[e.key.toLowerCase()];
        window.clearTimeout(armed.current);
        armed.current = null;
        if (target) {
          e.preventDefault();
          nav({ to: target.to });
          toast(target.label, { description: `g${e.key}`, duration: 1200 });
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [nav]);

  return (
    <Dialog open={helpOpen} onOpenChange={setHelpOpen}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Press <kbd className="border bg-surface px-1 font-mono text-[10px]">?</kbd> any time to
            toggle this list.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <section>
            <h3 className="mb-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              Global
            </h3>
            <ul className="space-y-1 text-sm">
              <Row keys={["⌘", "K"]} label="Open command palette" />
              <Row keys={["?"]} label="Toggle this cheat sheet" />
            </ul>
          </section>
          <section>
            <h3 className="mb-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              Navigate (press g, then…)
            </h3>
            <ul className="grid grid-cols-2 gap-1 text-sm">
              {Object.entries(NAV_SHORTCUTS).map(([k, v]) => (
                <Row key={k} keys={["g", k]} label={v.label} />
              ))}
            </ul>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Row({ keys, label }: { keys: string[]; label: string }) {
  return (
    <li className="flex items-center justify-between gap-3 px-2 py-1 hover:bg-sidebar-accent/40">
      <span className="text-foreground/90">{label}</span>
      <span className="flex items-center gap-1">
        {keys.map((k, i) => (
          <kbd
            key={i}
            className="border bg-surface px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
          >
            {k}
          </kbd>
        ))}
      </span>
    </li>
  );
}
