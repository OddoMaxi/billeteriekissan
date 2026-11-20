"use client";

import { CircleCheck, CircleX, LoaderCircle } from "lucide-react";
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
  variant = "primary",
}: {
  action: (prev: ActionState, form: FormData) => Promise<ActionState>;
  children: ReactNode;
  submitLabel?: string;
  className?: string;
  /** « danger » pour une action irréversible (blocage, annulation définitive). */
  variant?: "primary" | "danger";
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
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className={`btn btn-${variant}`}
        >
          {pending && <LoaderCircle className="h-4 w-4 animate-spin" />}
          {submitLabel}
        </button>
        {state?.error && (
          <p className="flex items-center gap-1.5 text-sm text-red-700" role="alert">
            <CircleX className="h-4 w-4 shrink-0" />
            {state.error}
          </p>
        )}
        {state?.ok && !state.error && (
          <p className="flex items-center gap-1.5 text-sm text-emerald-700" role="status">
            <CircleCheck className="h-4 w-4 shrink-0" />
            {state.ok}
          </p>
        )}
      </div>
    </form>
  );
}
