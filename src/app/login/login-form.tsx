"use client";

import { useActionState } from "react";
import { loginAction } from "./actions";

export function LoginForm() {
  const [state, action, pending] = useActionState(loginAction, null);
  return (
    <form action={action} className="space-y-4">
      <label className="block">
        E-mail
        <input name="email" type="email" autoComplete="username" required autoFocus defaultValue={state?.email} key={state?.email} />
      </label>
      <label className="block">
        Mot de passe
        <input name="password" type="password" autoComplete="current-password" required />
      </label>
      {state?.error && <p className="text-sm text-red-700" role="alert">{state.error}</p>}
      <button
        disabled={pending}
        className="w-full rounded-md bg-blue-700 py-2.5 font-semibold text-white hover:bg-blue-800 disabled:opacity-50"
      >
        {pending ? "Connexion…" : "Se connecter"}
      </button>
    </form>
  );
}
