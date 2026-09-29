import type { BatchStatus } from "@prisma/client";
import { Badge } from "@/components/ui";

const LABELS: Record<BatchStatus, [string, "gray" | "blue" | "green" | "red"]> = {
  PREPARING: ["Préparation", "gray"],
  GENERATING: ["Génération", "blue"],
  READY: ["Prêt", "green"],
  FAILED: ["Échec", "red"],
};

export function BatchStatusBadge({ status }: { status: BatchStatus }) {
  const [label, color] = LABELS[status];
  return <Badge color={color}>{label}</Badge>;
}
