import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Billetterie",
  description: "Création, impression et contrôle de billets physiques",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="fr" className="h-full antialiased">
      <body className="min-h-full bg-slate-50 text-slate-900">{children}</body>
    </html>
  );
}
