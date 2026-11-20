import "server-only";
import type { Prisma, ScanReason, ScanVerdict } from "@prisma/client";
import { audit } from "./audit";
import { isWellFormedQr, maskQr, sha256 } from "./crypto";
import { db } from "./db";
import { formatNumber } from "./numbering";
import { can, type Actor } from "./permissions";

// Contrôle d'entrée (section 7). Le serveur décide seul de la validité :
// droits du contrôleur, événement, porte, billet, état commercial, blocage, créneau.
// Contrôle à l'entrée uniquement (décision du 29/09/2026) : un billet donne droit à une seule entrée,
// sans lecture de sortie ni réentrée. Les motifs EXIT, REENTRY, NOT_INSIDE et NO_REENTRY restent
// connus de la base pour l'historique, mais ne sont plus produits.
// L'admission est une transition conditionnelle unique « non utilisé → utilisé » : si deux postes
// lisent le même billet au même instant, un seul obtient VALIDE. Chaque lecture porte un
// identifiant d'opération : une requête répétée (double signal, relance) renvoie le même verdict.
// Toute lecture, même refusée, est conservée.

export class ScanError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409,
  ) {
    super(message);
  }
}

export type ScanController = Actor & { controllerGateIds: string[] | null };

export type ScanResult = {
  scanId: string;
  verdict: ScanVerdict;
  reason: ScanReason;
  /** Titre affiché en très grand : VALIDE, DÉJÀ UTILISÉ, INEXISTANT… */
  title: string;
  /** Explication courte pour le contrôleur. */
  message: string;
  number: string | null;
  category: string | null;
  /** Admission précédente (déjà utilisé). */
  previous: { at: string; gate: string | null } | null;
  /** Dérogation possible par un superviseur (verdict « à vérifier »). */
  overridable: boolean;
  serverTime: string;
  /** Réponse rejouée : cette opération avait déjà été traitée. */
  replayed: boolean;
};

const TITLES: Record<ScanReason, string> = {
  OK: "VALIDE",
  REENTRY: "VALIDE",
  EXIT: "SORTIE ENREGISTRÉE",
  OVERRIDE: "ADMIS PAR DÉROGATION",
  UNKNOWN: "INEXISTANT",
  OTHER_EVENT: "AUTRE ÉVÉNEMENT",
  FORBIDDEN_GATE: "MAUVAISE PORTE",
  NOT_ACTIVATED: "NON VENDU",
  CANCELLED: "ANNULÉ",
  LOST: "DÉCLARÉ PERDU",
  DESTROYED: "DÉTRUIT",
  ALREADY_USED: "DÉJÀ UTILISÉ",
  NOT_INSIDE: "PAS À L'INTÉRIEUR",
  NO_REENTRY: "SORTIE DÉFINITIVE",
  OUT_OF_SLOT: "À VÉRIFIER",
  MANUAL_ENTRY: "À VÉRIFIER",
  AMBIGUOUS_NUMBER: "PRÉCISER LA CATÉGORIE",
  EVENT_CLOSED: "CONTRÔLE FERMÉ",
};

type Tx = Prisma.TransactionClient;

/** Droits du contrôleur sur la porte (revérifiés à chaque lecture : une révocation prend effet immédiatement). */
async function checkGate(tx: Tx, eventId: string, gateId: string, controller: ScanController) {
  if (!can(controller, "scan.perform")) throw new ScanError("Vous n'êtes pas contrôleur de cet événement.", 403);
  const gate = await tx.gate.findFirst({ where: { id: gateId, eventId } });
  if (!gate) throw new ScanError("Porte inconnue pour cet événement.", 404);
  if (!gate.active) throw new ScanError(`La porte « ${gate.name} » est fermée.`, 403);
  if (controller.controllerGateIds && !controller.controllerGateIds.includes(gateId)) {
    throw new ScanError(`Vous n'êtes pas affecté à la porte « ${gate.name} ».`, 403);
  }
  return gate;
}

function fmtTime(d: Date, tz: string) {
  return new Intl.DateTimeFormat("fr-FR", { timeZone: tz, hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(d);
}

async function toResult(
  scan: { id: string; verdict: ScanVerdict; reason: ScanReason; serverTime: Date; ticketId: string | null },
  replayed: boolean,
  tz: string,
): Promise<ScanResult> {
  const ticket = scan.ticketId
    ? await db.ticket.findUnique({ where: { id: scan.ticketId }, include: { category: true } })
    : null;
  let previous: ScanResult["previous"] = null;
  if (scan.reason === "ALREADY_USED" && ticket?.usedAt) {
    const gate = ticket.usedGateId ? await db.gate.findUnique({ where: { id: ticket.usedGateId } }) : null;
    previous = { at: fmtTime(ticket.usedAt, tz), gate: gate?.name ?? null };
  }
  const sameEvent = ticket && scan.reason !== "OTHER_EVENT";
  return {
    scanId: scan.id,
    verdict: scan.verdict,
    reason: scan.reason,
    title: TITLES[scan.reason],
    message: messageFor(scan.reason, previous),
    // Un billet d'un autre événement n'est pas détaillé au contrôleur.
    number: sameEvent ? formatNumber(ticket.number) : null,
    category: sameEvent ? ticket.category.name : null,
    previous,
    overridable: scan.verdict === "CHECK",
    serverTime: scan.serverTime.toISOString(),
    replayed,
  };
}

function messageFor(reason: ScanReason, previous: ScanResult["previous"]): string {
  switch (reason) {
    case "OK":
      return "Première entrée.";
    case "REENTRY":
      return "Réentrée après sortie enregistrée.";
    case "EXIT":
      return "Le porteur pourra rentrer avec ce billet.";
    case "OVERRIDE":
      return "Admission exceptionnelle enregistrée.";
    case "UNKNOWN":
      return "Ce QR ne correspond à aucun billet.";
    case "OTHER_EVENT":
      return "Billet d'un autre événement.";
    case "FORBIDDEN_GATE":
      return "Cette catégorie n'entre pas par cette porte.";
    case "NOT_ACTIVATED":
      return "Billet ni vendu ni activé : non utilisable.";
    case "CANCELLED":
      return "Billet annulé : non utilisable.";
    case "LOST":
      return "Billet déclaré perdu : non utilisable.";
    case "DESTROYED":
      return "Billet détruit ou remplacé : non utilisable.";
    case "ALREADY_USED":
      return previous ? `Entré à ${previous.at}${previous.gate ? `, porte « ${previous.gate} »` : ""}.` : "Billet déjà utilisé.";
    case "NOT_INSIDE":
      return "Ce billet n'est pas enregistré à l'intérieur.";
    case "NO_REENTRY":
      return "Cette catégorie n'autorise pas la réentrée : prévenez le porteur.";
    case "OUT_OF_SLOT":
      return "Hors du créneau de la catégorie : appelez le superviseur.";
    case "MANUAL_ENTRY":
      return "Numéro saisi à la main : vérifiez le billet papier, puis appelez le superviseur.";
    case "AMBIGUOUS_NUMBER":
      return "Ce numéro existe dans plusieurs catégories : saisissez la catégorie puis le numéro (ex. « VIP 012 »).";
    case "EVENT_CLOSED":
      return "L'événement n'est pas ouvert au contrôle.";
  }
}

/** Conditions d'admission indépendantes de l'état d'entrée : porte de la catégorie, vendu ou activé. */
function admissionProblem(
  ticket: { commercialState: string; activatedAt: Date | null },
  cat: { gateIds: string[] },
  gateId: string,
): ScanReason | null {
  if (cat.gateIds.length > 0 && !cat.gateIds.includes(gateId)) return "FORBIDDEN_GATE";
  // Politique d'activation retenue : vendu (vente déclarée) ou activé par lot.
  if (ticket.commercialState !== "SOLD" && !ticket.activatedAt) return "NOT_ACTIVATED";
  return null;
}

export type ScanInput = {
  eventId: string;
  gateId: string;
  controller: ScanController;
  value: string;
  operationId: string;
  deviceId?: string | null;
  /** Lecture faite hors connexion par le poste, transmise au retour du réseau. */
  offline?: OfflineReading;
};

/** Ce que le poste a lu et affiché hors connexion. */
export type OfflineReading = { deviceTime: Date; verdict: ScanVerdict; reason: ScanReason };

/** Traite une lecture. Idempotent par `operationId`. */
export async function processScan(input: ScanInput): Promise<ScanResult> {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(input.operationId)) throw new ScanError("Identifiant d'opération invalide.", 400);
  const value = input.value.trim().slice(0, 500);
  const event = await db.event.findUniqueOrThrow({ where: { id: input.eventId } });
  const tz = event.timezone;

  const existing = await db.scan.findUnique({ where: { operationId: input.operationId } });
  if (existing) {
    if (existing.controllerId !== input.controller.id || existing.eventId !== input.eventId) {
      throw new ScanError("Identifiant d'opération déjà utilisé.", 409);
    }
    return toResult(existing, true, tz);
  }

  try {
    const offline = input.offline;
    const scan = await db.$transaction(async (tx) => {
      const gate = await checkGate(tx, input.eventId, input.gateId, input.controller);
      const record = (verdict: ScanVerdict, reason: ScanReason, ticketId: string | null) =>
        tx.scan.create({
          data: {
            operationId: input.operationId,
            eventId: input.eventId,
            gateId: gate.id,
            controllerId: input.controller.id,
            deviceId: input.deviceId?.slice(0, 64) || null,
            ticketId,
            maskedValue: maskQr(value),
            verdict,
            reason,
            ...(offline && {
              offline: true,
              deviceTime: offline.deviceTime,
              offlineVerdict: offline.verdict,
              // Le porteur est entré sur la foi du poste, mais le serveur n'aurait pas admis le billet.
              offlineConflict: offline.verdict === "VALID" && verdict !== "VALID",
            }),
          },
        });

      // Une lecture hors connexion est enregistrée même si l'événement a été fermé entre-temps :
      // le porteur est déjà passé, il faut le compter.
      if (event.status !== "OPEN" && !offline) return record("REFUSED", "EVENT_CLOSED", null);

      // Numéro tapé à la main : ne prouve pas l'authenticité. Mêmes contrôles qu'un scan, mais un billet
      // qui serait valide donne « à vérifier » (dérogation supervisée), jamais d'admission directe.
      // Saisie « 012 » ou « VIP 012 » : chaque catégorie a sa propre numérotation.
      const typed = /^(?:(.+?)\s+)?(\d{1,7})$/.exec(value);
      const manual = !!typed;
      if (!manual && !isWellFormedQr(value)) return record("REFUSED", "UNKNOWN", null);
      let ticket;
      if (typed) {
        const candidates = await tx.ticket.findMany({
          where: {
            eventId: input.eventId,
            number: Number(typed[2]),
            ...(typed[1] ? { category: { name: { equals: typed[1].trim(), mode: "insensitive" } } } : {}),
          },
          include: { category: true },
        });
        if (candidates.length > 1) return record("REFUSED", "AMBIGUOUS_NUMBER", null);
        ticket = candidates[0];
      } else {
        ticket = await tx.ticket.findUnique({ where: { qrHash: sha256(value) }, include: { category: true } });
      }
      // Lecture hors connexion non admise par le poste : simple trace, le billet n'est jamais marqué utilisé
      // (le porteur n'est pas entré, ou attend le superviseur).
      if (offline && offline.verdict !== "VALID") {
        return record(offline.verdict, offline.reason, ticket && ticket.eventId === input.eventId ? ticket.id : null);
      }
      if (!ticket) return record("REFUSED", "UNKNOWN", null);
      if (ticket.eventId !== input.eventId) return record("REFUSED", "OTHER_EVENT", ticket.id);
      if (ticket.blockState !== "NONE") return record("REFUSED", ticket.blockState, ticket.id);
      const cat = ticket.category;
      if (manual) {
        const denied = admissionProblem(ticket, cat, gate.id);
        if (denied) return record("REFUSED", denied, ticket.id);
        if (ticket.entryState === "USED") return record("REFUSED", "ALREADY_USED", ticket.id);
        return record("CHECK", "MANUAL_ENTRY", ticket.id);
      }

      const denied = admissionProblem(ticket, cat, gate.id);
      if (denied) return record("REFUSED", denied, ticket.id);
      // Hors connexion : l'heure de passage est celle du poste (jamais dans le futur).
      const now = offline ? new Date(Math.min(offline.deviceTime.getTime(), Date.now())) : new Date();
      // Le créneau a déjà été vérifié par le poste hors connexion, à l'heure du passage.
      if (!offline && ((cat.slotStart && now < cat.slotStart) || (cat.slotEnd && now > cat.slotEnd))) {
        return record("CHECK", "OUT_OF_SLOT", ticket.id);
      }

      // Admission atomique : une seule lecture peut faire passer le billet de « non utilisé » à « utilisé ».
      const first = await tx.ticket.updateMany({
        where: { id: ticket.id, entryState: "NOT_USED" },
        data: { entryState: "USED", usedAt: now, usedGateId: gate.id, entryCount: { increment: 1 } },
      });
      if (first.count === 1) return record("VALID", "OK", ticket.id);

      return record("REFUSED", "ALREADY_USED", ticket.id);
    });
    return toResult(scan, false, tz);
  } catch (e) {
    // Même opération reçue deux fois en parallèle : la seconde transaction échoue sur l'unicité
    // (et son éventuelle admission est annulée avec elle) ; on renvoie le verdict de la première.
    if ((e as { code?: string })?.code === "P2002") {
      const first = await db.scan.findUnique({ where: { operationId: input.operationId } });
      if (first) return toResult(first, true, tz);
    }
    throw e;
  }
}

/**
 * Dérogation supervisée (hors créneau, saisie manuelle) : un superviseur admet le billet.
 * L'admission reste atomique et unique ; elle est tracée comme exception, avec son motif.
 */
export async function overrideAdmission(p: { scanId: string; actor: Actor; reason: string; operationId: string }): Promise<ScanResult> {
  if (!can(p.actor, "scan.override")) throw new ScanError("Seul un superviseur (organisateur ou gestionnaire) peut admettre par dérogation.", 403);
  if (p.reason.trim().length < 5) throw new ScanError("Indiquez le motif de la dérogation.", 400);
  const source = await db.scan.findUnique({ where: { id: p.scanId }, include: { event: true } });
  if (!source || source.verdict !== "CHECK" || !source.ticketId) throw new ScanError("Cette lecture ne peut pas faire l'objet d'une dérogation.", 400);
  const tz = source.event.timezone;
  if (source.event.status !== "OPEN") throw new ScanError("L'événement n'est pas ouvert au contrôle.", 409);

  const existing = await db.scan.findUnique({ where: { operationId: p.operationId } });
  if (existing) return toResult(existing, true, tz);

  const scan = await db.$transaction(async (tx) => {
    const ticket = await tx.ticket.findUniqueOrThrow({ where: { id: source.ticketId! }, include: { category: true } });
    let verdict: ScanVerdict = "REFUSED";
    let reason: ScanReason;
    // L'état du billet a pu changer depuis la lecture : les conditions sont revérifiées.
    const denied = ticket.blockState !== "NONE" ? ticket.blockState : admissionProblem(ticket, ticket.category, source.gateId);
    if (denied) reason = denied;
    else {
      const r = await tx.ticket.updateMany({
        where: { id: ticket.id, entryState: "NOT_USED" },
        data: { entryState: "USED", usedAt: new Date(), usedGateId: source.gateId, entryCount: { increment: 1 } },
      });
      if (r.count === 1) {
        verdict = "VALID";
        reason = "OVERRIDE";
      } else reason = "ALREADY_USED";
    }
    const s = await tx.scan.create({
      data: {
        operationId: p.operationId,
        eventId: source.eventId,
        gateId: source.gateId,
        controllerId: p.actor.id,
        deviceId: source.deviceId,
        ticketId: ticket.id,
        maskedValue: source.maskedValue,
        verdict,
        reason,
        exception: verdict === "VALID",
        exceptionReason: p.reason.trim(),
        overridesScanId: source.id,
      },
    });
    await audit(tx, {
      actorId: p.actor.id,
      eventId: source.eventId,
      action: "scan.override",
      objectType: "Ticket",
      objectId: ticket.id,
      after: { verdict, reason, number: formatNumber(ticket.number), initial: source.reason },
      context: { reason: p.reason.trim(), gateId: source.gateId },
    });
    return s;
  });
  return toResult(scan, false, tz);
}

// ─── Incidents de porte ──────────────────────────────────────────────────────

export async function reportIncident(p: { eventId: string; gateId: string; controller: ScanController; message: string }) {
  if (p.message.trim().length < 3) throw new ScanError("Décrivez l'incident.", 400);
  return db.$transaction(async (tx) => {
    await checkGate(tx, p.eventId, p.gateId, p.controller);
    const i = await tx.gateIncident.create({
      data: { eventId: p.eventId, gateId: p.gateId, controllerId: p.controller.id, message: p.message.trim().slice(0, 1000) },
    });
    await audit(tx, { actorId: p.controller.id, eventId: p.eventId, action: "gate.incident", objectType: "GateIncident", objectId: i.id, after: i });
    return i;
  });
}

export async function resolveIncident(p: { incidentId: string; actor: Actor; resolution: string }) {
  if (!can(p.actor, "scan.override")) throw new ScanError("Réservé au superviseur.", 403);
  const r = await db.gateIncident.updateMany({
    where: { id: p.incidentId, resolvedAt: null },
    data: { resolvedAt: new Date(), resolvedById: p.actor.id, resolution: p.resolution.trim().slice(0, 1000) || null },
  });
  if (r.count === 0) throw new ScanError("Incident déjà traité.", 409);
}

// ─── Supervision ─────────────────────────────────────────────────────────────

/** Entrées et refus par porte, motifs de refus, admissions exceptionnelles. */
export async function gateStats(eventId: string) {
  const [byGate, byReason, inside, admitted, exceptions] = await Promise.all([
    db.scan.groupBy({ by: ["gateId", "verdict"], where: { eventId }, _count: true }),
    db.scan.groupBy({ by: ["reason"], where: { eventId, verdict: { not: "VALID" } }, _count: true }),
    db.ticket.count({ where: { eventId, entryState: "USED" } }),
    db.ticket.count({ where: { eventId, entryState: "USED" } }),
    db.scan.count({ where: { eventId, exception: true } }),
  ]);
  return { byGate, byReason, inside, admitted, exceptions };
}

// ─── Contrôle hors connexion ─────────────────────────────────────────────────

/** État d'un billet dans la copie hors connexion (même ordre de contrôle que le serveur). */
export const OFFLINE_STATE = { OK: 0, NOT_ACTIVATED: 1, USED: 2, CANCELLED: 3, LOST: 4, DESTROYED: 5 } as const;

export type OfflineSnapshot =
  | { disabled: true }
  | {
      disabled: false;
      version: string;
      generatedAt: string;
      eventStatus: string;
      timezone: string;
      gate: { id: string; name: string };
      gateNames: Record<string, string>;
      /** Catégories : porte autorisée ici, créneau (ms depuis l'époque). */
      categories: { name: string; allowedHere: boolean; slotStart: number | null; slotEnd: number | null }[];
      /** [empreinte sha256 du QR, index de catégorie, numéro, état, heure d'entrée (ms), porte d'entrée] */
      tickets: [string, number, number, number, number | null, string | null][];
    };

/**
 * Copie de l'événement pour le contrôle hors connexion d'une porte.
 * Ne contient que des empreintes : impossible d'en tirer un QR valide.
 */
export async function offlineSnapshot(p: { eventId: string; gateId: string; controller: ScanController }): Promise<OfflineSnapshot> {
  const gate = await checkGate(db, p.eventId, p.gateId, p.controller);
  const event = await db.event.findUniqueOrThrow({ where: { id: p.eventId } });
  if (!event.offlineScan) return { disabled: true };
  const [gates, categories, tickets] = await Promise.all([
    db.gate.findMany({ where: { eventId: p.eventId }, select: { id: true, name: true } }),
    db.category.findMany({ where: { eventId: p.eventId }, orderBy: { name: "asc" } }),
    db.ticket.findMany({
      where: { eventId: p.eventId },
      select: { qrHash: true, categoryId: true, number: true, commercialState: true, activatedAt: true, blockState: true, entryState: true, usedAt: true, usedGateId: true },
      orderBy: [{ categoryId: "asc" }, { number: "asc" }],
    }),
  ]);
  const catIndex = new Map(categories.map((c, i) => [c.id, i]));
  const body = {
    eventStatus: event.status,
    timezone: event.timezone,
    gate: { id: gate.id, name: gate.name },
    gateNames: Object.fromEntries(gates.map((g) => [g.id, g.name])),
    categories: categories.map((c) => ({
      name: c.name,
      allowedHere: c.gateIds.length === 0 || c.gateIds.includes(gate.id),
      slotStart: c.slotStart?.getTime() ?? null,
      slotEnd: c.slotEnd?.getTime() ?? null,
    })),
    tickets: tickets.map((t): [string, number, number, number, number | null, string | null] => {
      const state =
        t.blockState !== "NONE"
          ? OFFLINE_STATE[t.blockState]
          : t.entryState === "USED"
            ? OFFLINE_STATE.USED
            : t.commercialState !== "SOLD" && !t.activatedAt
              ? OFFLINE_STATE.NOT_ACTIVATED
              : OFFLINE_STATE.OK;
      return [t.qrHash, catIndex.get(t.categoryId)!, t.number, state, t.usedAt?.getTime() ?? null, t.usedGateId];
    }),
  };
  const version = sha256(JSON.stringify(body)).slice(0, 24);
  return { disabled: false, version, generatedAt: new Date().toISOString(), ...body };
}
