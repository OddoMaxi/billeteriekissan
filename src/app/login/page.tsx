import type { Metadata } from "next";
import Image from "next/image";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { ClearOfflinePages } from "./clear-offline-pages";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Connexion" };

export default async function LoginPage() {
  if (await getCurrentUser()) redirect("/");
  return (
    <main className="grid min-h-screen lg:grid-cols-[1.1fr_1fr]">
      {/* Panneau de marque */}
      <section className="relative hidden overflow-hidden bg-blue-950 p-12 text-white lg:flex lg:flex-col">
        {/* Trame de billets perforés, très discrète */}
        <svg aria-hidden className="absolute inset-0 h-full w-full opacity-[0.07]">
          <defs>
            <pattern id="perforation" width="28" height="28" patternUnits="userSpaceOnUse">
              <circle cx="14" cy="14" r="1.6" fill="currentColor" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#perforation)" />
        </svg>
        <div className="relative rounded-2xl bg-white px-6 py-5 shadow-sm w-fit">
          <Image src="/brand/souli-souli.png" alt="Souli-Souli by Kissan Technologies" width={1474} height={436} priority className="h-auto w-[220px]" />
        </div>
        <div className="relative mt-auto max-w-md">
          <p className="font-display text-[40px] leading-[1.05] font-semibold tracking-tight">
            Du billet imprimé
            <br />
            <span className="text-brand-400">à la porte d&apos;entrée.</span>
          </p>
          <p className="mt-5 text-[15px] leading-relaxed text-blue-200">
            Création des modèles, impression des lots, distribution aux vendeurs, caisse et contrôle d&apos;accès : toute la
            billetterie physique de vos événements, au même endroit.
          </p>
        </div>
      </section>

      {/* Formulaire */}
      <section className="flex items-center justify-center px-5 py-12 sm:px-10">
        <div className="w-full max-w-sm">
          <Image src="/brand/souli-souli.png" alt="Souli-Souli by Kissan Technologies" width={1474} height={436} priority className="mx-auto mb-10 h-auto w-[200px] lg:hidden" />
          <h1 className="font-display text-[28px] font-semibold tracking-tight text-slate-900">Connexion</h1>
          <p className="mt-1.5 mb-8 text-sm text-slate-500">Accédez à votre espace avec les identifiants fournis par l&apos;organisateur.</p>
          <LoginForm />
          <ClearOfflinePages />
        </div>
      </section>
    </main>
  );
}
