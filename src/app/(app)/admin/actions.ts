"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { formAction, formToObject, UserError } from "@/lib/action";
import { audit } from "@/lib/audit";
import { requireAdmin, revokeUserSessions } from "@/lib/auth";
import { hashPassword } from "@/lib/crypto";
import { db } from "@/lib/db";

const password = z.string().min(10, "Le mot de passe doit faire au moins 10 caractères.").max(200);

// ─── Organismes ──────────────────────────────────────────────────────────────

const orgSchema = z.object({
  name: z.string().trim().min(2, "Nom requis.").max(200),
  contact: z.string().trim().max(300).optional(),
});

export const createOrganization = formAction(async (form) => {
  const admin = await requireAdmin();
  const data = orgSchema.parse(formToObject(form));
  await db.$transaction(async (tx) => {
    const org = await tx.organization.create({ data: { name: data.name, contact: data.contact || null } });
    await audit(tx, { actorId: admin.id, action: "organization.create", objectType: "Organization", objectId: org.id, after: org });
  });
  revalidatePath("/admin/organizations");
  return "Organisme créé.";
});

export async function setOrganizationStatus(orgId: string, status: "ACTIVE" | "DISABLED") {
  const admin = await requireAdmin();
  await db.$transaction(async (tx) => {
    const before = await tx.organization.findUniqueOrThrow({ where: { id: orgId } });
    const after = await tx.organization.update({ where: { id: orgId }, data: { status } });
    await audit(tx, { actorId: admin.id, action: "organization.status", objectType: "Organization", objectId: orgId, before, after });
  });
  revalidatePath("/admin/organizations");
}

// ─── Comptes ─────────────────────────────────────────────────────────────────

const userSchema = z.object({
  name: z.string().trim().min(2, "Nom requis.").max(200),
  email: z.string().trim().toLowerCase().email("E-mail invalide."),
  phone: z.string().trim().max(50).optional(),
  password,
  isAdmin: z.literal("on").optional(),
});

export const createUser = formAction(async (form) => {
  const admin = await requireAdmin();
  const data = userSchema.parse(formToObject(form));
  if (await db.user.findUnique({ where: { email: data.email } })) throw new UserError("Cet e-mail est déjà utilisé.");
  await db.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        name: data.name,
        email: data.email,
        phone: data.phone || null,
        passwordHash: await hashPassword(data.password),
        isAdmin: data.isAdmin === "on",
      },
    });
    await audit(tx, {
      actorId: admin.id,
      action: "user.create",
      objectType: "User",
      objectId: user.id,
      after: { email: user.email, name: user.name, isAdmin: user.isAdmin },
    });
  });
  revalidatePath("/admin/users");
  return "Compte créé.";
});

/** Désactivation : effet immédiat, toutes les sessions sont révoquées (R09). */
export async function setUserStatus(userId: string, status: "ACTIVE" | "DISABLED") {
  const admin = await requireAdmin();
  if (userId === admin.id && status === "DISABLED") throw new UserError("Vous ne pouvez pas désactiver votre propre compte.");
  await db.$transaction(async (tx) => {
    await tx.user.update({ where: { id: userId }, data: { status } });
    await audit(tx, { actorId: admin.id, action: "user.status", objectType: "User", objectId: userId, after: { status } });
  });
  if (status === "DISABLED") await revokeUserSessions(userId);
  revalidatePath("/admin/users");
}

export const resetPassword = formAction(async (form) => {
  const admin = await requireAdmin();
  const { userId, password: pwd } = z.object({ userId: z.string().uuid(), password }).parse(formToObject(form));
  await db.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: { passwordHash: await hashPassword(pwd), failedLogins: 0, lockedUntil: null },
    });
    await audit(tx, { actorId: admin.id, action: "user.password_reset", objectType: "User", objectId: userId });
  });
  await revokeUserSessions(userId);
  return "Mot de passe réinitialisé ; les sessions ouvertes sont fermées.";
});
