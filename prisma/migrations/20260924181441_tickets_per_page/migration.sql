-- Passage à 5 tickets par A4 (décision du 24/09/2026).
-- Les lots déjà produits l'ont été à 4 par page : ils le restent, pour que leur réimpression
-- redonne exactement le même fichier. Les nouveaux lots sont à 5 par page.
ALTER TABLE "Batch" ADD COLUMN "ticketsPerPage" INTEGER NOT NULL DEFAULT 4;
ALTER TABLE "Batch" ALTER COLUMN "ticketsPerPage" SET DEFAULT 5;
