import type { EventRole, EventStatus } from "@prisma/client";

export const ROLE_LABELS: Record<EventRole, string> = {
  ORGANIZER: "Organisateur",
  TICKET_MANAGER: "Gestionnaire de billetterie",
  SELLER: "Vendeur",
  CONTROLLER: "Contrôleur",
  AUDITOR: "Auditeur / comptable",
};

export const EVENT_STATUS_LABELS: Record<EventStatus, string> = {
  DRAFT: "Brouillon",
  OPEN: "Ouvert",
  CLOSED: "Terminé",
  ARCHIVED: "Archivé",
};

export const EVENT_STATUS_COLORS: Record<EventStatus, "gray" | "green" | "orange" | "red"> = {
  DRAFT: "gray",
  OPEN: "green",
  CLOSED: "orange",
  ARCHIVED: "red",
};

export const MOVEMENT_LABELS: Record<string, string> = {
  ASSIGN: "Remise",
  RETURN: "Retour au stock central",
  LOSS: "Perte",
  DAMAGE: "Dommage / destruction",
  CANCEL: "Annulation",
  REPLACE: "Remplacement",
  ACTIVATE: "Activation",
  DEACTIVATE: "Désactivation",
};

export const MOVEMENT_STATUS_LABELS: Record<string, string> = {
  PENDING: "En attente de réception",
  CONFIRMED: "Confirmé",
  REFUSED: "Refusé",
};

export const PAYMENT_METHOD_LABELS: Record<string, string> = {
  CASH: "Espèces",
  TRANSFER: "Transfert",
  OTHER: "Autre",
};

export const BLOCK_LABELS: Record<string, string> = {
  NONE: "",
  CANCELLED: "Annulé",
  LOST: "Perdu",
  DESTROYED: "Détruit",
};

export const COMMERCIAL_LABELS: Record<string, string> = {
  IN_STOCK: "Stock central",
  ASSIGNED: "Remis",
  SOLD: "Vendu",
};
