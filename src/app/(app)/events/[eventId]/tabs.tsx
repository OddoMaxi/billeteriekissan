"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function EventTabs({ base, tabs }: { base: string; tabs: { href: string; label: string }[] }) {
  const pathname = usePathname();
  return (
    <nav className="mb-6 flex flex-wrap gap-1 border-b border-slate-200 text-sm">
      {tabs.map((t) => {
        const href = base + t.href;
        const active = t.href === "" ? pathname === base : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            className={`-mb-px border-b-2 px-3 py-2 ${active ? "border-blue-700 font-semibold text-blue-700" : "border-transparent text-slate-600 hover:text-slate-900"}`}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
