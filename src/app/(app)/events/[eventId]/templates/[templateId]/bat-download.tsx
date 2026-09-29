"use client";

import { useState } from "react";

/** Choix du profil puis ouverture du BAT A4 correspondant. */
export function BatDownload({ templateId, profiles }: { templateId: string; profiles: { id: string; name: string }[] }) {
  const [profile, setProfile] = useState(profiles[0]?.id ?? "");
  if (profiles.length === 0) return <p className="text-sm text-red-700">Créez d&apos;abord un profil d&apos;impression.</p>;
  return (
    <div className="flex flex-wrap items-end gap-3">
      <label className="block">
        Profil d&apos;impression
        <select value={profile} onChange={(e) => setProfile(e.target.value)}>
          {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </label>
      <a
        href={`/api/templates/${templateId}/bat?profile=${profile}`}
        target="_blank"
        className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium hover:bg-slate-100"
      >
        Télécharger le BAT (A4, 5 spécimens)
      </a>
    </div>
  );
}
