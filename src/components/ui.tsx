import { CircleCheck, CircleX, Info, TriangleAlert } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

export function PageTitle({ children, actions, description }: { children: ReactNode; actions?: ReactNode; description?: ReactNode }) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="font-display text-[28px] leading-tight font-semibold tracking-tight text-slate-900 sm:text-[32px]">{children}</h1>
        {description && <p className="mt-1.5 max-w-2xl text-sm text-slate-500">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Card({
  title,
  description,
  actions,
  children,
  flush = false,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  /** Contenu collé aux bords (tableaux larges). */
  flush?: boolean;
}) {
  return (
    <section className="mb-6 rounded-2xl border border-slate-200 bg-white">
      {(title || actions) && (
        <header className={`flex flex-wrap items-start justify-between gap-3 px-5 pt-5 sm:px-6 ${flush ? "pb-4" : "pb-1"}`}>
          <div className="min-w-0">
            {title && <h2 className="text-[15px] font-semibold text-slate-900">{title}</h2>}
            {description && <p className="mt-1 text-sm text-slate-500">{description}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={flush ? "" : `px-5 pb-5 sm:px-6 ${title || actions ? "pt-4" : "pt-5"}`}>{children}</div>
    </section>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block">
      {label}
      {children}
      {hint && <span className="mt-1.5 block text-xs font-normal text-slate-500">{hint}</span>}
    </label>
  );
}

export function Grid({ children }: { children: ReactNode }) {
  return <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{children}</div>;
}

export function Table({ head, children, empty }: { head: ReactNode[]; children: ReactNode; empty?: boolean }) {
  return (
    <div className="-mx-5 overflow-x-auto sm:-mx-6">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-y border-slate-200 bg-slate-50/70">
            {head.map((h, i) => (
              <th key={i} className="px-3 py-2.5 text-xs font-medium whitespace-nowrap text-slate-500 first:pl-5 last:pr-5 sm:first:pl-6 sm:last:pr-6">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 [&>tr]:transition-colors [&>tr:hover]:bg-slate-50/60">
          {empty ? (
            <tr>
              <td colSpan={head.length} className="px-6 py-10 text-center text-sm text-slate-500">
                Aucun élément pour l&apos;instant.
              </td>
            </tr>
          ) : (
            children
          )}
        </tbody>
      </table>
    </div>
  );
}

export function Td({ children, className = "" }: { children?: ReactNode; className?: string }) {
  return <td className={`px-3 py-3 align-top text-slate-700 first:pl-5 last:pr-5 sm:first:pl-6 sm:last:pr-6 ${className}`}>{children}</td>;
}

const BADGE = {
  gray: "bg-slate-100 text-slate-700 ring-slate-200",
  green: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  red: "bg-red-50 text-red-800 ring-red-200",
  orange: "bg-amber-50 text-amber-800 ring-amber-200",
  blue: "bg-blue-50 text-blue-800 ring-blue-200",
} as const;
const DOT = { gray: "bg-slate-400", green: "bg-emerald-500", red: "bg-red-500", orange: "bg-amber-500", blue: "bg-blue-600" } as const;

export function Badge({ children, color = "gray" }: { children: ReactNode; color?: keyof typeof BADGE }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset ${BADGE[color]}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${DOT[color]}`} />
      {children}
    </span>
  );
}

export function LinkButton({ href, children, variant = "secondary" }: { href: string; children: ReactNode; variant?: "primary" | "secondary" | "accent" }) {
  return (
    <Link href={href} className={`btn btn-${variant}`}>
      {children}
    </Link>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "warning" | "danger" }) {
  return (
    <div className="min-w-0 rounded-2xl border border-slate-200 bg-white p-4 sm:p-5">
      <div className="text-[13px] font-medium text-slate-500">{label}</div>
      <div
        className={`font-display mt-2 text-[21px] leading-none sm:text-[28px] font-semibold tracking-tight tabular-nums ${
          tone === "danger" ? "text-red-700" : tone === "warning" ? "text-amber-700" : "text-slate-900"
        }`}
      >
        {value}
      </div>
      {sub && <div className="mt-2 text-xs text-slate-500">{sub}</div>}
    </div>
  );
}

/** Choix de la catégorie des billets saisis (chaque catégorie a sa propre numérotation) ; caché s'il n'y en a qu'une. */
export function CategoryField({ categories }: { categories: { id: string; name: string }[] }) {
  if (categories.length === 1) return <input type="hidden" name="categoryId" value={categories[0].id} />;
  return (
    <Field label="Catégorie">
      <select name="categoryId" required defaultValue="">
        <option value="" disabled>Choisir…</option>
        {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
    </Field>
  );
}

const NOTICE = {
  error: { box: "border-red-200 bg-red-50 text-red-900", icon: "text-red-600" },
  warning: { box: "border-amber-200 bg-amber-50 text-amber-900", icon: "text-amber-600" },
  info: { box: "border-slate-200 bg-slate-50 text-slate-700", icon: "text-slate-400" },
  success: { box: "border-emerald-200 bg-emerald-50 text-emerald-900", icon: "text-emerald-600" },
} as const;

/** Message encadré avec icône (erreur, avertissement, information, succès). */
export function Notice({ level = "info", children, compact = false }: { level?: keyof typeof NOTICE; children: ReactNode; compact?: boolean }) {
  const Icon = level === "error" ? CircleX : level === "warning" ? TriangleAlert : level === "success" ? CircleCheck : Info;
  return (
    <div className={`flex gap-2.5 rounded-xl border text-sm ${compact ? "px-3 py-2" : "px-4 py-3"} ${NOTICE[level].box}`}>
      <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${NOTICE[level].icon}`} strokeWidth={2} />
      <div className="min-w-0">{children}</div>
    </div>
  );
}
