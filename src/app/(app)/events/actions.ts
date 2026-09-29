"use server";

import type { EventRole } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { formAction, formToObject, UserError } from "@/lib/action";
import { audit } from "@/lib/audit";
import { requireAdmin } from "@/lib/auth";
import { requireEventPermission } from "@/lib/authz";
import { hashPassword } from "@/lib/crypto";
import { db } from "@/lib/db";
import { isValidTimeZone, parseLocalDateTime } from "@/lib/time";

const uuid = z.string().uuid();
const localDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "Date et heure requises.");
const optionalText = (max: number) => z.string().trim().max(max).optional().transform((v) => v || null);

// ─── Événements ──────────────────────────────────────────────────────────────

const eventSchema = z.object({
  name: z.string().trim().min(2, "Nom requis.").max(200),
  description: optionalText(5000),
  venue: z.string().trim().min(2, "Lieu requis.").max(200),
  address: optionalText(500),
  timezone: z.string().refine(isValidTimeZone, "Fuseau horaire inconnu."),
  doorsOpenAt: localDateTime,
  startsAt: localDateTime,
  endsAt: localDateTime,
});

function eventDates(d: z.infer<typeof eventSchema>) {
  const doorsOpenAt = parseLocalDateTime(d.doorsOpenAt, d.timezone);
  const startsAt = parseLocalDateTime(d.startsAt, d.timezone);
  const endsAt = parseLocalDateTime(d.endsAt, d.timezone);
  if (doorsOpenAt > startsAt) throw new UserError("L'ouverture des portes doit précéder le début.");
  if (startsAt >= endsAt) throw new UserError("La fin doit suivre le début.");
  return { doorsOpenAt, startsAt, endsAt };
}

export const createEvent = formAction(async (form) => {
  const admin = await requireAdmin();
  const raw = formToObject(form);
  const data = eventSchema.parse(raw);
  const organizationId = uuid.parse(raw.organizationId);
  const event = await db.$transaction(async (tx) => {
    const e = await tx.event.create({
      data: {
        organizationId,
        name: data.name,
        description: data.description,
        venue: data.venue,
        address: data.address,
        timezone: data.timezone,
        ...eventDates(data),
      },
    });
    await tx.gate.create({ data: { eventId: e.id, name: "Entrée principale" } });
    await audit(tx, { actorId: admin.id, eventId: e.id, action: "event.create", objectType: "Event", objectId: e.id, after: e });
    return e;
  });
  redirect(`/events/${event.id}/settings`);
});

/**
 * L'organisateur complète les paramètres autorisés (description, lieu, horaires) ;
 * nom, fuseau et organisme restent à l'administrateur.
 */
export const updateEvent = formAction(async (form) => {
  const raw = formToObject(form);
  const eventId = uuid.parse(raw.eventId);
  const access = await requireEventPermission(eventId, "event.configure");
  const before = await db.event.findUniqueOrThrow({ where: { id: eventId } });
  if (before.status === "CLOSED" || before.status === "ARCHIVED") {
    throw new UserError("Un événement terminé ou archivé n'est plus modifiable.");
  }
  const data = eventSchema.parse(
    access.user.isAdmin ? raw : { ...raw, name: before.name, timezone: before.timezone },
  );
  await db.$transaction(async (tx) => {
    const after = await tx.event.update({
      where: { id: eventId },
      data: {
        name: data.name,
        description: data.description,
        venue: data.venue,
        address: data.address,
        timezone: data.timezone,
        ...eventDates(data),
      },
    });
    await audit(tx, { actorId: access.user.id, eventId, action: "event.update", objectType: "Event", objectId: eventId, before, after });
  });
  revalidatePath(`/events/${eventId}`, "layout");
  return "Événement enregistré.";
});

const STATUS_FLOW = {
  DRAFT: ["OPEN"],
  OPEN: ["CLOSED"],
  CLOSED: ["OPEN", "ARCHIVED"],
  ARCHIVED: [],
} as const;

export const setEventStatus = formAction(async (form) => {
  const admin = await requireAdmin();
  const raw = formToObject(form);
  const eventId = uuid.parse(raw.eventId);
  const status = z.enum(["DRAFT", "OPEN", "CLOSED", "ARCHIVED"]).parse(raw.status);
  const reason = z.string().trim().max(500).parse(raw.reason ?? "");
  const before = await db.event.findUniqueOrThrow({ where: { id: eventId } });
  if (!(STATUS_FLOW[before.status] as readonly string[]).includes(status)) {
    throw new UserError("Transition d'état non autorisée.");
  }
  // Rouvrir un événement terminé est une dérogation : motif obligatoire.
  if (before.status === "CLOSED" && status === "OPEN" && reason.length < 5) {
    throw new UserError("Indiquez le motif de la réouverture.");
  }
  await db.$transaction(async (tx) => {
    await tx.event.update({ where: { id: eventId }, data: { status } });
    await audit(tx, {
      actorId: admin.id,
      eventId,
      action: "event.status",
      objectType: "Event",
      objectId: eventId,
      before: { status: before.status },
      after: { status },
      context: reason ? { reason } : undefined,
    });
  });
  revalidatePath(`/events/${eventId}`, "layout");
  return "État mis à jour.";
});

// ─── Catégories (administrateur : prix et quotas) ────────────────────────────

const categorySchema = z.object({
  eventId: uuid,
  name: z.string().trim().min(1, "Nom requis.").max(100),
  priceGnf: z.coerce.number().int("Prix entier en GNF.").min(0, "Prix invalide."),
  quota: z.coerce.number().int().min(1, "Quota invalide.").max(1_000_000),
  accessConditions: optionalText(1000),
  slotStart: z.string().optional(),
  slotEnd: z.string().optional(),
  gateIds: z.union([uuid, z.array(uuid)]).optional(),
  reentryAllowed: z.literal("on").optional(),
});

export const saveCategory = formAction(async (form) => {
  const admin = await requireAdmin();
  const raw = formToObject(form);
  const data = categorySchema.parse(raw);
  const categoryId = raw.categoryId ? uuid.parse(raw.categoryId) : null;
  const event = await db.event.findUniqueOrThrow({ where: { id: data.eventId } });
  const slotStart = data.slotStart ? parseLocalDateTime(data.slotStart, event.timezone) : null;
  const slotEnd = data.slotEnd ? parseLocalDateTime(data.slotEnd, event.timezone) : null;
  if (slotStart && slotEnd && slotStart >= slotEnd) throw new UserError("Créneau invalide.");
  const gateIds = data.gateIds ? [data.gateIds].flat() : [];
  const values = {
    name: data.name,
    priceGnf: data.priceGnf,
    quota: data.quota,
    accessConditions: data.accessConditions,
    slotStart,
    slotEnd,
    gateIds,
    reentryAllowed: data.reentryAllowed === "on",
  };

  await db.$transaction(async (tx) => {
    if (categoryId) {
      const before = await tx.category.findFirstOrThrow({ where: { id: categoryId, eventId: data.eventId } });
      const issued = await tx.ticket.count({ where: { categoryId } });
      if (values.quota < issued) throw new UserError(`Le quota ne peut pas descendre sous les ${issued} billets déjà générés.`);
      if (issued > 0 && values.priceGnf !== before.priceGnf) {
        throw new UserError("Le prix facial est figé une fois des billets générés.");
      }
      const after = await tx.category.update({ where: { id: categoryId }, data: values });
      await audit(tx, { actorId: admin.id, eventId: data.eventId, action: "category.update", objectType: "Category", objectId: categoryId, before, after });
    } else {
      const created = await tx.category.create({ data: { ...values, eventId: data.eventId } });
      await audit(tx, { actorId: admin.id, eventId: data.eventId, action: "category.create", objectType: "Category", objectId: created.id, after: created });
    }
  }).catch((e) => {
    if (e?.code === "P2002") throw new UserError("Une catégorie porte déjà ce nom.");
    throw e;
  });
  revalidatePath(`/events/${data.eventId}`, "layout");
  return categoryId ? "Catégorie mise à jour." : "Catégorie créée.";
});

// ─── Portes ──────────────────────────────────────────────────────────────────

export const createGate = formAction(async (form) => {
  const raw = formToObject(form);
  const eventId = uuid.parse(raw.eventId);
  const access = await requireEventPermission(eventId, "event.configure");
  const name = z.string().trim().min(1, "Nom requis.").max(100).parse(raw.name);
  await db.$transaction(async (tx) => {
    const gate = await tx.gate.create({ data: { eventId, name } });
    await audit(tx, { actorId: access.user.id, eventId, action: "gate.create", objectType: "Gate", objectId: gate.id, after: gate });
  }).catch((e) => {
    if (e?.code === "P2002") throw new UserError("Une porte porte déjà ce nom.");
    throw e;
  });
  revalidatePath(`/events/${eventId}/settings`);
  return "Porte ajoutée.";
});

export async function toggleGate(eventId: string, gateId: string) {
  const access = await requireEventPermission(eventId, "event.configure");
  await db.$transaction(async (tx) => {
    const gate = await tx.gate.findFirstOrThrow({ where: { id: gateId, eventId } });
    await tx.gate.update({ where: { id: gateId }, data: { active: !gate.active } });
    await audit(tx, { actorId: access.user.id, eventId, action: "gate.toggle", objectType: "Gate", objectId: gateId, after: { active: !gate.active } });
  });
  revalidatePath(`/events/${eventId}/settings`);
}

// ─── Équipe ──────────────────────────────────────────────────────────────────

const ROLES = ["ORGANIZER", "TICKET_MANAGER", "SELLER", "CONTROLLER", "AUDITOR"] as const;

const memberSchema = z.object({
  eventId: uuid,
  email: z.string().trim().toLowerCase().email("E-mail invalide."),
  role: z.enum(ROLES),
  name: z.string().trim().max(200).optional(),
  password: z.string().max(200).optional(),
  gateIds: z.union([uuid, z.array(uuid)]).optional(),
});

/**
 * Ajoute un rôle sur l'événement. Si le compte n'existe pas, l'organisateur peut le créer
 * (compte simple, jamais administrateur). Seul l'administrateur nomme un organisateur.
 */
export const addMember = formAction(async (form) => {
  const data = memberSchema.parse(formToObject(form));
  const access = await requireEventPermission(data.eventId, "team.manage");
  if (data.role === "ORGANIZER" && !access.user.isAdmin) {
    throw new UserError("Seul l'administrateur central peut nommer un organisateur.");
  }
  const gateIds = data.role === "CONTROLLER" && data.gateIds ? [data.gateIds].flat() : [];
  if (gateIds.length) {
    const valid = await db.gate.count({ where: { id: { in: gateIds }, eventId: data.eventId } });
    if (valid !== gateIds.length) throw new UserError("Porte inconnue.");
  }

  await db.$transaction(async (tx) => {
    let user = await tx.user.findUnique({ where: { email: data.email } });
    if (!user) {
      if (!data.name || data.name.length < 2 || !data.password || data.password.length < 10) {
        throw new UserError("Compte inexistant : renseignez le nom et un mot de passe initial (10 caractères minimum) pour le créer.");
      }
      user = await tx.user.create({
        data: { email: data.email, name: data.name, passwordHash: await hashPassword(data.password) },
      });
      await audit(tx, {
        actorId: access.user.id,
        eventId: data.eventId,
        action: "user.create",
        objectType: "User",
        objectId: user.id,
        after: { email: user.email, name: user.name },
      });
    }
    const existing = await tx.eventMembership.findUnique({
      where: { userId_eventId_role: { userId: user.id, eventId: data.eventId, role: data.role } },
    });
    if (existing && !existing.revokedAt) throw new UserError("Ce compte a déjà ce rôle sur l'événement.");
    const membership = existing
      ? await tx.eventMembership.update({ where: { id: existing.id }, data: { revokedAt: null, gateIds } })
      : await tx.eventMembership.create({ data: { userId: user.id, eventId: data.eventId, role: data.role, gateIds } });
    await audit(tx, {
      actorId: access.user.id,
      eventId: data.eventId,
      action: "membership.grant",
      objectType: "EventMembership",
      objectId: membership.id,
      after: { userId: user.id, role: data.role, gateIds },
    });
  });
  revalidatePath(`/events/${data.eventId}/team`);
  return "Membre ajouté.";
});

/** Révocation immédiate : l'accès est revérifié en base à chaque requête. */
export async function revokeMember(eventId: string, membershipId: string) {
  const access = await requireEventPermission(eventId, "team.manage");
  await db.$transaction(async (tx) => {
    const m = await tx.eventMembership.findFirstOrThrow({ where: { id: membershipId, eventId } });
    if (m.role === ("ORGANIZER" satisfies EventRole) && !access.user.isAdmin) {
      throw new UserError("Seul l'administrateur central peut retirer un organisateur.");
    }
    await tx.eventMembership.update({ where: { id: m.id }, data: { revokedAt: new Date() } });
    await audit(tx, {
      actorId: access.user.id,
      eventId,
      action: "membership.revoke",
      objectType: "EventMembership",
      objectId: m.id,
      before: { userId: m.userId, role: m.role },
    });
  });
  revalidatePath(`/events/${eventId}/team`);
}
