"use client";

import { useEffect } from "react";

/**
 * À la page de connexion (après déconnexion ou session fermée), on retire la copie de l'écran
 * de contrôle gardée pour l'usage hors connexion. Les lectures en attente d'envoi sont conservées.
 */
export function ClearOfflinePages() {
  useEffect(() => {
    if (typeof caches !== "undefined") void caches.delete("controle-pages-v1").catch(() => {});
  }, []);
  return null;
}
