import "server-only";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { audit } from "./audit";
import { newSessionToken, sha256, verifyPassword } from "./crypto";
import { db } from "./db";

const COOKIE = "session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 h, couvre une journée d'événement
const IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 h sans activité
const MAX_FAILED_LOGINS = 5;
const LOCK_MS = 15 * 60 * 1000;

export type CurrentUser = {
  id: string;
  email: string;
  name: string;
  isAdmin: boolean;
  sessionId: string;
};

export type LoginResult = { ok: true } | { ok: false; error: string };

export async function login(email: string, password: string): Promise<LoginResult> {
  const generic = { ok: false as const, error: "Identifiants incorrects." };
  const user = await db.user.findUnique({ where: { email: email.trim().toLowerCase() } });
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;

  if (!user) {
    // Même coût qu'une vraie vérification pour ne pas révéler l'existence du compte.
    await verifyPassword(password, DUMMY_HASH);
    return generic;
  }
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    return { ok: false, error: "Compte temporairement verrouillé après plusieurs échecs. Réessayez plus tard." };
  }
  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    const failed = user.failedLogins + 1;
    await db.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: {
          failedLogins: failed >= MAX_FAILED_LOGINS ? 0 : failed,
          lockedUntil: failed >= MAX_FAILED_LOGINS ? new Date(Date.now() + LOCK_MS) : null,
        },
      });
      await audit(tx, { actorId: user.id, action: "auth.login_failed", objectType: "User", objectId: user.id, context: { ip } });
    });
    return generic;
  }
  if (user.status !== "ACTIVE") return generic;

  const token = newSessionToken();
  const now = Date.now();
  await db.$transaction(async (tx) => {
    await tx.user.update({ where: { id: user.id }, data: { failedLogins: 0, lockedUntil: null } });
    const session = await tx.session.create({
      data: {
        tokenHash: sha256(token),
        userId: user.id,
        expiresAt: new Date(now + SESSION_TTL_MS),
        userAgent: h.get("user-agent")?.slice(0, 300) ?? null,
        ip,
      },
    });
    await audit(tx, { actorId: user.id, action: "auth.login", objectType: "Session", objectId: session.id, context: { ip } });
  });

  (await cookies()).set(COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
  return { ok: true };
}

export async function logout(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (token) {
    await db.session.updateMany({ where: { tokenHash: sha256(token), revokedAt: null }, data: { revokedAt: new Date() } });
  }
  jar.delete(COOKIE);
}

/**
 * Utilisateur de la requête, ou null. La session est relue en base à chaque requête :
 * une révocation ou une désactivation de compte prend effet immédiatement (R09).
 */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  const session = await db.session.findUnique({
    where: { tokenHash: sha256(token) },
    include: { user: true },
  });
  const now = new Date();
  if (
    !session ||
    session.revokedAt ||
    session.expiresAt <= now ||
    now.getTime() - session.lastSeenAt.getTime() > IDLE_TIMEOUT_MS ||
    session.user.status !== "ACTIVE"
  ) {
    return null;
  }
  // Rafraîchit l'activité au plus une fois par minute.
  if (now.getTime() - session.lastSeenAt.getTime() > 60_000) {
    await db.session.update({ where: { id: session.id }, data: { lastSeenAt: now } });
  }
  const { user } = session;
  return { id: user.id, email: user.email, name: user.name, isAdmin: user.isAdmin, sessionId: session.id };
});

export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

export async function requireAdmin(): Promise<CurrentUser> {
  const user = await requireUser();
  if (!user.isAdmin) redirect("/");
  return user;
}

/** Révoque toutes les sessions d'un utilisateur (désactivation, changement de mot de passe). */
export async function revokeUserSessions(userId: string): Promise<void> {
  await db.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
}

// Hash scrypt d'un mot de passe aléatoire jamais utilisé, pour égaliser les temps de réponse.
const DUMMY_HASH =
  "scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$" + Buffer.alloc(64).toString("base64");
