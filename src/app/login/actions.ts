"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { login, logout } from "@/lib/auth";

const schema = z.object({
  email: z.string().email("E-mail invalide."),
  password: z.string().min(1, "Mot de passe requis."),
});

type LoginState = { error: string; email: string } | null;

export async function loginAction(_prev: LoginState, form: FormData): Promise<LoginState> {
  const email = String(form.get("email") ?? "");
  const parsed = schema.safeParse({ email, password: form.get("password") });
  if (!parsed.success) return { error: parsed.error.issues[0].message, email };
  const result = await login(parsed.data.email, parsed.data.password);
  // L'e-mail est renvoyé pour rester dans le champ après un échec.
  if (!result.ok) return { error: result.error, email };
  redirect("/");
}

export async function logoutAction() {
  await logout();
  redirect("/login");
}
