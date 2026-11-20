import type { Metadata, Viewport } from "next";
import { Bricolage_Grotesque, Instrument_Sans } from "next/font/google";
import "./globals.css";

// Texte courant : sobre et très lisible. Titres et chiffres clés : grotesque expressive, en écho au logo.
const sans = Instrument_Sans({ subsets: ["latin"], variable: "--font-instrument", display: "swap" });
const display = Bricolage_Grotesque({ subsets: ["latin"], variable: "--font-bricolage", display: "swap" });

export const metadata: Metadata = {
  title: { default: "Souli-Souli", template: "%s · Souli-Souli" },
  description: "Billetterie physique : création, impression, vente et contrôle des billets.",
};

export const viewport: Viewport = { themeColor: "#faf9fb" };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="fr" className={`h-full antialiased ${sans.variable} ${display.variable}`}>
      <body className="min-h-full bg-slate-50 text-slate-900">{children}</body>
    </html>
  );
}
