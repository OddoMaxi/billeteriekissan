"use client";

import { startTransition, useActionState, useEffect, useRef, type FormEvent, type ReactNode } from "react";

type ActionState = { error?: string; ok?: string } | null;

/**
 * Formulaire relié à une Server Action. La saisie est conservée en cas d'erreur
 * (React viderait sinon le formulaire) et effacée seulement après un succès.
 */
export function ActionForm({
  action,
  children,
  submitLabel = "Enregistrer",
  className = "space-y-4",
}: {
  action: (prev: ActionState, form: FormData) => Promise<ActionState>;
  children: ReactNode;
  submitLabel?: string;
  className?: string;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  const ref = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state?.ok) ref.current?.reset();
  }, [state]);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    startTransition(() => formAction(data));
  }

  return (
    <form ref={ref} onSubmit={onSubmit} className={className}>
      {children}
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-50"
        >
          {pending ? "…" : submitLabel}
        </button>
        {state?.error && <p className="text-sm text-red-700" role="alert">{state.error}</p>}
        {state?.ok && !state.error && <p className="text-sm text-green-700">{state.ok}</p>}
      </div>
    </form>
  );
}
