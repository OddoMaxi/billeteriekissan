"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** Onglets de l'événement : une seule ligne qui défile horizontalement sur petit écran. */
export function EventTabs({ base, tabs }: { base: string; tabs: { href: string; label: string }[] }) {
  const pathname = usePathname();
  return (
    <nav className="no-scrollbar -mx-4 mb-8 overflow-x-auto border-b border-slate-200 px-4 sm:mx-0 sm:px-0">
      <ul className="flex min-w-max gap-6 text-sm">
        {tabs.map((t) => {
          const href = base + t.href;
          const active = t.href === "" ? pathname === base : pathname.startsWith(href);
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={`relative -mb-px block border-b-2 py-3 font-medium transition-colors ${
                  active ? "border-brand-600 text-slate-900" : "border-transparent text-slate-500 hover:text-slate-900"
                }`}
              >
                {t.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
