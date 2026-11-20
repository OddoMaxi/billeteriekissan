"use client";

import { Building2, CalendarDays, LayoutDashboard, LogOut, Menu, Printer, ScrollText, Users, X } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

const ICONS = {
  dashboard: LayoutDashboard,
  events: CalendarDays,
  organizations: Building2,
  users: Users,
  print: Printer,
  audit: ScrollText,
};

export type NavItem = { href: string; label: string; icon: keyof typeof ICONS };
export type NavSection = { title?: string; items: NavItem[] };

function Logo() {
  return (
    <Link href="/" className="block w-fit" aria-label="Souli-Souli, accueil">
      <Image src="/brand/souli-souli.png" alt="Souli-Souli by Kissan Technologies" width={1474} height={436} priority className="h-auto w-[176px]" />
    </Link>
  );
}

function Nav({ sections, onNavigate }: { sections: NavSection[]; onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav className="space-y-6">
      {sections.map((section, i) => (
        <div key={i}>
          {section.title && <div className="mb-2 px-3 text-[11px] font-semibold tracking-wider text-slate-400 uppercase">{section.title}</div>}
          <ul className="space-y-0.5">
            {section.items.map((item) => {
              const Icon = ICONS[item.icon];
              const active = pathname === item.href || pathname.startsWith(item.href + "/");
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    className={`group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                      active ? "bg-blue-50 text-blue-800" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                    }`}
                  >
                    {active && <span className="absolute top-2 bottom-2 -left-3 w-[3px] rounded-r-full bg-brand-600" />}
                    <Icon className={`h-[18px] w-[18px] ${active ? "text-blue-700" : "text-slate-400 group-hover:text-slate-600"}`} strokeWidth={1.75} />
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function Account({ name, role, logout }: { name: string; role: string; logout: () => Promise<void> }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
  return (
    <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-2.5">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-blue-100 text-xs font-semibold text-blue-800">{initials || "?"}</span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-slate-900">{name}</div>
        <div className="truncate text-xs text-slate-500">{role}</div>
      </div>
      <form action={logout}>
        <button className="btn btn-ghost h-8 w-8 px-0" title="Déconnexion" aria-label="Déconnexion">
          <LogOut className="h-4 w-4" strokeWidth={1.75} />
        </button>
      </form>
    </div>
  );
}

export function AppShell({
  sections,
  user,
  logout,
  children,
}: {
  sections: NavSection[];
  user: { name: string; role: string };
  logout: () => Promise<void>;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // Le tiroir mobile se ferme à chaque changement de page.
  const [lastPath, setLastPath] = useState(pathname);
  if (lastPath !== pathname) {
    setLastPath(pathname);
    setOpen(false);
  }
  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  return (
    <div className="min-h-screen lg:pl-64">
      {/* Barre latérale (ordinateur) */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-slate-200 bg-white px-4 py-6 lg:flex">
        <div className="px-3">
          <Logo />
        </div>
        <div className="mt-10 flex-1 overflow-y-auto">
          <Nav sections={sections} />
        </div>
        <Account {...user} logout={logout} />
      </aside>

      {/* Barre du haut (mobile) */}
      <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-slate-200 bg-white/90 px-4 backdrop-blur lg:hidden">
        <Image src="/brand/souli-souli.png" alt="Souli-Souli" width={1474} height={436} priority className="h-auto w-[120px]" />
        <button onClick={() => setOpen(true)} className="btn btn-ghost h-10 w-10 px-0" aria-label="Ouvrir le menu">
          <Menu className="h-5 w-5" />
        </button>
      </header>

      {/* Tiroir (mobile) */}
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true">
          <div className="absolute inset-0 bg-slate-950/40" onClick={() => setOpen(false)} />
          <div className="shell-drawer absolute inset-y-0 left-0 flex w-[min(20rem,85vw)] flex-col bg-white px-4 py-5 shadow-xl">
            <div className="flex items-center justify-between px-3">
              <Logo />
              <button onClick={() => setOpen(false)} className="btn btn-ghost h-10 w-10 px-0" aria-label="Fermer le menu">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="mt-8 flex-1 overflow-y-auto">
              <Nav sections={sections} onNavigate={() => setOpen(false)} />
            </div>
            <Account {...user} logout={logout} />
          </div>
        </div>
      )}

      <main className="mx-auto max-w-[1180px] px-4 py-6 sm:px-6 lg:px-10 lg:py-10">{children}</main>
    </div>
  );
}
