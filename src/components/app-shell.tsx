import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { createContext, useContext, useState } from "react";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { LogOut, Radio, Menu, Search } from "lucide-react";
import { NAV_SECTIONS } from "@/lib/nav";
import { Button } from "@/components/ui/button";
import { NotificationsBell } from "@/components/notifications-bell";
import { NavSecurityBadge } from "@/components/nav-security-badge";
import { CommandPalette } from "@/components/command-palette";
import { KeyboardShortcuts } from "@/components/keyboard-shortcuts";
import { OnboardingWizard } from "@/components/onboarding-wizard";
import { GitHubRateLimitMeter } from "@/components/github-rate-limit-meter";
import { ThemeToggle } from "@/components/theme-toggle";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";

const AppShellContext = createContext(false);

export function AppShell({ children }: { children: React.ReactNode }) {
  const alreadyInShell = useContext(AppShellContext);
  const { user, signOut } = useAuth();
  const loc = useLocation();
  const nav = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);

  // Idempotency: if an ancestor already rendered AppShell, pass through.
  // Prevents duplicated sidebars when nested routes each wrap in ProtectedRoute.
  if (alreadyInShell) {
    return <>{children}</>;
  }

  const navLinks = NAV_SECTIONS.map((section) => (
    <div key={section.heading} className="space-y-0.5">
      <p className="px-3 pb-1 pt-4 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground/60 first:pt-0">
        {section.heading}
      </p>
      {section.items.map((item) => {
        const to = item.to as string;
        const active = loc.pathname === to || loc.pathname.startsWith(to + "/");
        const Icon = item.icon;
        return (
          <Link
            key={to}
            to={item.to}
            onClick={() => setMobileOpen(false)}
            className={cn(
              "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
              active
                ? "bg-sidebar-accent text-foreground"
                : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
            )}
          >
            <Icon className={cn("h-4 w-4", active && "text-primary")} />
            <span>{item.label}</span>
            {to === "/security" && <NavSecurityBadge />}
            {active && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-primary" />}
          </Link>
        );
      })}
    </div>
  ));

  return (
    <AppShellContext.Provider value={true}>
      <div className="flex min-h-dvh w-full">
        {/* Desktop sidebar */}
        <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col border-r border-border/60 bg-sidebar p-4 md:flex">
          <Link to="/dashboard" className="mb-8 flex items-center gap-2">
            <div className="relative flex h-9 w-9 items-center justify-center rounded-md bg-primary/15 ring-1 ring-primary/40">
              <Radio className="h-5 w-5 text-primary" />
              <span className="absolute -right-0.5 -top-0.5 h-2 w-2 animate-pulse rounded-full bg-accent" />
            </div>
            <div className="flex flex-col leading-tight">
              <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
                Aurixa Systems
              </span>
              <span className="font-mono text-sm font-semibold tracking-wide text-foreground">
                MISSION CONTROL
              </span>
            </div>
          </Link>

          <nav className="flex-1 min-h-0 space-y-1 overflow-y-auto pr-1">{navLinks}</nav>

          <div className="mt-auto rounded-md border border-border/60 bg-surface p-3">
            <div className="mb-2 truncate font-mono text-[11px] text-muted-foreground">
              {user?.email}
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start text-muted-foreground hover:text-foreground"
              onClick={async () => {
                await signOut();
                nav({ to: "/auth" });
              }}
            >
              <LogOut className="mr-2 h-4 w-4" /> Sign out
            </Button>
          </div>
        </aside>

        <main className="flex-1 min-w-0">
          {/* Mobile top bar */}
          <header className="md:hidden sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border/60 bg-background/80 px-4 backdrop-blur">
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9 shrink-0"
              onClick={() => setMobileOpen(true)}
            >
              <Menu className="h-5 w-5" />
              <span className="sr-only">Open menu</span>
            </Button>
            <div className="flex items-center gap-2">
              <Radio className="h-4 w-4 text-primary" />
              <div className="flex flex-col leading-none">
                <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground">
                  Aurixa
                </span>
                <span className="font-mono text-xs font-semibold tracking-wide">
                  MISSION CONTROL
                </span>
              </div>
            </div>
            <div className="ml-auto flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                className="h-9 w-9"
                onClick={() => window.dispatchEvent(new Event("open-command-palette"))}
                aria-label="Open command palette"
              >
                <Search className="h-4 w-4" />
              </Button>
              <ThemeToggle />
              <NotificationsBell />
            </div>
          </header>

          {/* Mobile navigation drawer */}
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetContent side="left" className="w-72 p-0">
              <SheetHeader className="sr-only">
                <SheetTitle>Navigation</SheetTitle>
                <SheetDescription>Main navigation menu</SheetDescription>
              </SheetHeader>
              <div className="flex h-full flex-col bg-sidebar">
                <div className="flex items-center gap-2 border-b border-border/60 p-4">
                  <div className="relative flex h-8 w-8 items-center justify-center rounded-md bg-primary/15 ring-1 ring-primary/40">
                    <Radio className="h-4 w-4 text-primary" />
                    <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
                  </div>
                  <div className="flex flex-col leading-tight">
                    <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground">
                      Aurixa Systems
                    </span>
                    <span className="font-mono text-xs font-semibold tracking-wide text-foreground">
                      MISSION CONTROL
                    </span>
                  </div>
                </div>

                <nav className="flex-1 space-y-1 overflow-y-auto p-3">{navLinks}</nav>

                <div className="border-t border-border/60 p-3">
                  <div className="mb-2 truncate font-mono text-[10px] text-muted-foreground">
                    {user?.email}
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full justify-start text-muted-foreground hover:text-foreground"
                    onClick={async () => {
                      setMobileOpen(false);
                      await signOut();
                      nav({ to: "/auth" });
                    }}
                  >
                    <LogOut className="mr-2 h-4 w-4" /> Sign out
                  </Button>
                </div>
              </div>
            </SheetContent>
          </Sheet>

          {/* Desktop top bar */}
          <header className="hidden md:flex sticky top-0 z-30 h-12 items-center justify-end gap-2 border-b border-border/60 bg-background/80 px-6 backdrop-blur">
            <GitHubRateLimitMeter />
            <kbd className="hidden lg:inline-flex items-center gap-1 rounded border border-border/60 bg-surface px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              ⌘K
              <span className="text-muted-foreground/60">command palette</span>
            </kbd>
            <ThemeToggle />
            <NotificationsBell />
          </header>
          <div className="p-4 md:p-8">{children}</div>
        </main>
        <CommandPalette />
        <KeyboardShortcuts />
        <OnboardingWizard />
      </div>
    </AppShellContext.Provider>
  );
}
