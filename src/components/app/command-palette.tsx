"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { FileSpreadsheet, FolderKanban, ListChecks, Package, Plus, Store, Building2, UsersRound } from "lucide-react";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useI18n } from "@/lib/i18n/client";
import { searchAction } from "@/app/actions/shell";
import type { SearchHit } from "@/server/modules/search/service";
import { ICONS, type NavSection } from "./sidebar";

const HIT_ICONS = { project: FolderKanban, task: ListChecks, recipient: UsersRound, delivery: Package, vendor: Store, client: Building2 };

export function CommandPalette({ orgSlug, open, onOpenChange, nav }: { orgSlug: string; open: boolean; onOpenChange: (o: boolean) => void; nav: NavSection[] }) {
  const { m } = useI18n();
  const router = useRouter();
  const [q, setQ] = useState("");
  const [results, setHits] = useState<SearchHit[]>([]);
  const hits = q.trim().length < 2 ? [] : results;
  const [help, setHelp] = useState(false);
  const seq = useRef(0);
  const base = `/o/${orgSlug}`;

  // ⌘K / Ctrl+K, "g" chords, and "?" for help
  useEffect(() => {
    let chord: string | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable);
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        onOpenChange(!open);
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "?") {
        setHelp(true);
        return;
      }
      if (chord === "g") {
        const map: Record<string, string> = { d: "", p: "/projects", m: "/my-work", t: "/dispatch", r: "/reports", n: "/notifications" };
        if (e.key in map) router.push(base + map[e.key]);
        chord = null;
        return;
      }
      if (e.key === "g") {
        chord = "g";
        clearTimeout(timer);
        timer = setTimeout(() => (chord = null), 900);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange, router, base]);

  useEffect(() => {
    if (!open) return;
    const term = q.trim();
    if (term.length < 2) return;
    const id = ++seq.current;
    const t = setTimeout(async () => {
      const r = await searchAction(orgSlug, { q: term });
      if (id === seq.current && r.ok) setHits(r.data);
    }, 180);
    return () => clearTimeout(t);
  }, [q, open, orgSlug]);

  const go = (href: string) => {
    onOpenChange(false);
    setQ("");
    router.push(href.startsWith("/o/") ? href : base + href);
  };

  return (
    <>
      <CommandDialog open={open} onOpenChange={onOpenChange} title={m.common.commandPalette} description={m.shell.searchHint} shouldFilter={!hits.length}>
        <CommandInput placeholder={m.shell.searchAnything} value={q} onValueChange={setQ} />
        <CommandList>
          <CommandEmpty>{m.common.noResults}</CommandEmpty>
          {hits.length > 0 && (
            <CommandGroup heading={m.shell.results}>
              {hits.map((h) => {
                const Icon = HIT_ICONS[h.kind];
                return (
                  <CommandItem key={`${h.kind}-${h.id}`} value={`${h.title} ${h.subtitle ?? ""} ${h.id}`} onSelect={() => go(h.href)}>
                    <Icon className="size-4 text-muted-foreground" />
                    <span className="truncate">{h.title}</span>
                    {h.subtitle && <span className="ltr-nums ms-auto truncate text-xs text-muted-foreground">{h.subtitle}</span>}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          )}
          <CommandGroup heading={m.shell.quickActions}>
            <CommandItem onSelect={() => go("/projects/new")}>
              <Plus className="size-4" /> {m.shell.newProject}
            </CommandItem>
            <CommandItem onSelect={() => go("/delivery")}>
              <FileSpreadsheet className="size-4" /> {m.shell.newImport}
            </CommandItem>
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading={m.shell.navigation}>
            {nav.flatMap((s) => s.items).map((i) => {
              const Icon = ICONS[i.key];
              return (
                <CommandItem key={i.href} onSelect={() => go(i.href)} value={`nav ${i.label}`}>
                  {Icon && <Icon className="size-4 text-muted-foreground" />} {i.label}
                </CommandItem>
              );
            })}
          </CommandGroup>
        </CommandList>
      </CommandDialog>
      <Dialog open={help} onOpenChange={setHelp}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{m.common.shortcuts}</DialogTitle>
          </DialogHeader>
          <dl className="grid gap-2 text-sm">
            {[
              ["⌘ K", m.shell.shortcutPalette],
              ["G D", m.shell.shortcutGoDashboard],
              ["G P", m.shell.shortcutGoProjects],
              ["G M", m.shell.shortcutGoMyWork],
              ["G T", m.shell.shortcutGoDispatch],
              ["?", m.shell.shortcutHelp],
            ].map(([k, label]) => (
              <div key={k} className="flex items-center justify-between gap-4">
                <dt>{label}</dt>
                <dd className="flex gap-1">
                  {k.split(" ").map((p) => (
                    <span key={p} className="kbd">{p}</span>
                  ))}
                </dd>
              </div>
            ))}
          </dl>
        </DialogContent>
      </Dialog>
    </>
  );
}
