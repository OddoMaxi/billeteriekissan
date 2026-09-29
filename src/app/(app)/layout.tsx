import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { logoutAction } from "../login/actions";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const user = await requireUser();
  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <nav className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3 text-sm">
          <Link href="/" className="font-bold">Billetterie</Link>
          <Link href="/events" className="hover:underline">Événements</Link>
          {user.isAdmin && <Link href="/dashboard" className="hover:underline">Tableau de bord</Link>}
          {user.isAdmin && (
            <>
              <Link href="/admin/organizations" className="hover:underline">Organismes</Link>
              <Link href="/admin/users" className="hover:underline">Comptes</Link>
              <Link href="/admin/print-profiles" className="hover:underline">Impression</Link>
              <Link href="/admin/audit" className="hover:underline">Audit</Link>
            </>
          )}
          <span className="ml-auto text-slate-500">
            {user.name}
            {user.isAdmin && " · administrateur"}
          </span>
          <form action={logoutAction}>
            <button className="text-slate-600 hover:underline">Déconnexion</button>
          </form>
        </nav>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}
