import "server-only";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";

export type ActionState = { error?: string; ok?: string } | null;

/** Erreur métier affichable telle quelle à l'utilisateur. */
export class UserError extends Error {}

/**
 * Enveloppe une Server Action de formulaire : les erreurs de validation et métier
 * deviennent un message ; redirect/notFound et les erreurs inattendues suivent leur cours.
 */
export function formAction(
  fn: (form: FormData) => Promise<string | void>,
): (prev: ActionState, form: FormData) => Promise<ActionState> {
  return async (_prev, form) => {
    try {
      const ok = await fn(form);
      return ok ? { ok } : { ok: "Enregistré." };
    } catch (err) {
      unstable_rethrow(err);
      if (err instanceof z.ZodError) {
        return { error: err.issues.map((i) => i.message).join(" ") };
      }
      if (err instanceof UserError) return { error: err.message };
      throw err;
    }
  };
}

/** Lit un FormData en objet simple (les champs multiples deviennent des tableaux). */
export function formToObject(form: FormData): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const key of new Set(form.keys())) {
    if (key.startsWith("$ACTION")) continue;
    const all = form.getAll(key).filter((v): v is string => typeof v === "string");
    out[key] = all.length > 1 ? all : (all[0] ?? "");
  }
  return out;
}
