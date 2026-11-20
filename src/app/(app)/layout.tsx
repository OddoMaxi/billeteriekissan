import { AppShell, type NavSection } from "@/components/app-shell";
import { requireUser } from "@/lib/auth";
import { logoutAction } from "../login/actions";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const user = await requireUser();
  const sections: NavSection[] = [
    {
      items: [
        ...(user.isAdmin ? [{ href: "/dashboard", label: "Tableau de bord", icon: "dashboard" as const }] : []),
        { href: "/events", label: "Événements", icon: "events" },
      ],
    },
    ...(user.isAdmin
      ? [
          {
            title: "Administration",
            items: [
              { href: "/admin/organizations", label: "Organismes", icon: "organizations" as const },
              { href: "/admin/users", label: "Comptes", icon: "users" as const },
              { href: "/admin/print-profiles", label: "Impression", icon: "print" as const },
              { href: "/admin/audit", label: "Journal d'audit", icon: "audit" as const },
            ],
          },
        ]
      : []),
  ];
  return (
    <AppShell sections={sections} user={{ name: user.name, role: user.isAdmin ? "Administrateur" : "Membre" }} logout={logoutAction}>
      {children}
    </AppShell>
  );
}
