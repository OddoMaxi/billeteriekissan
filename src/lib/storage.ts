import "server-only";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

// Stockage des fichiers hors du dossier public. Les chemins relatifs sont toujours
// construits par l'application, jamais fournis par l'utilisateur.

function root(): string {
  return path.resolve(process.env.STORAGE_DIR ?? "./storage");
}

function resolveSafe(relPath: string): string {
  const full = path.resolve(root(), relPath);
  if (!full.startsWith(root() + path.sep)) throw new Error("Chemin de stockage invalide");
  return full;
}

/** Écriture atomique : fichier temporaire puis renommage (un fichier partiel n'est jamais visible). */
export async function saveFile(relPath: string, data: Uint8Array): Promise<void> {
  const full = resolveSafe(relPath);
  await mkdir(path.dirname(full), { recursive: true });
  const tmp = `${full}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, data);
  await rename(tmp, full);
}

export async function loadFile(relPath: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(resolveSafe(relPath)));
}

export async function deleteFile(relPath: string): Promise<void> {
  await rm(resolveSafe(relPath), { force: true });
}
