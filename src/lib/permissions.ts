import type { EventRole } from "@prisma/client";

/**
 * Permissions par couple utilisateur × événement (section 2).
 * Refus par défaut : une action absente de cette table n'est accordée qu'à l'administrateur central.
 * Module pur (sans dépendance serveur) : utilisé par les pages, les actions et la logique métier.
 */
export const PERMISSIONS = {
  "event.view": ["ORGANIZER", "TICKET_MANAGER", "SELLER", "CONTROLLER", "AUDITOR"],
  "event.configure": ["ORGANIZER"],
  "team.manage": ["ORGANIZER"],
  "tickets.view": ["ORGANIZER", "TICKET_MANAGER", "AUDITOR"],
  /** Remises, retours, pertes, activation, remplacements, confirmation des retours. */
  "stock.assign": ["ORGANIZER", "TICKET_MANAGER"],
  /** Détenir des billets : confirmer une réception, vendre ses billets, restituer. */
  "stock.own": ["SELLER", "TICKET_MANAGER", "ORGANIZER"],
  /** Enregistrer ou corriger une vente pour le compte de n'importe quel vendeur. */
  "sale.manage": ["ORGANIZER", "TICKET_MANAGER"],
  /** Accorder une remise au-delà du plafond de la catégorie. */
  "sale.discount_override": ["ORGANIZER", "TICKET_MANAGER"],
  "payment.validate": ["ORGANIZER", "TICKET_MANAGER"],
  "finance.view": ["ORGANIZER", "TICKET_MANAGER", "AUDITOR"],
  "report.export": ["ORGANIZER", "AUDITOR"],
  "scan.perform": ["CONTROLLER"],
  /** Admission par dérogation (hors créneau, saisie manuelle) et traitement des incidents de porte. */
  "scan.override": ["ORGANIZER", "TICKET_MANAGER"],
  "gates.view": ["ORGANIZER", "TICKET_MANAGER", "AUDITOR"],
  // Réservé à l'administrateur central : modèles, BAT, génération et impression.
  "templates.manage": [],
} as const satisfies Record<string, readonly EventRole[]>;

export type Permission = keyof typeof PERMISSIONS;

/** Acteur d'une opération sur un événement. */
export type Actor = { id: string; isAdmin: boolean; roles: ReadonlySet<EventRole> };

export function can(actor: Actor, p: Permission): boolean {
  return actor.isAdmin || PERMISSIONS[p].some((r: EventRole) => actor.roles.has(r));
}
