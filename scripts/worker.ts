// Service de génération des PDF de lots, exécuté hors du serveur web :
// le rendu (plusieurs secondes de calcul pour 10 000 billets) ne ralentit jamais les scans.
//
//   npm run worker        (production : un seul exemplaire, supervisé par systemd, pm2…)
//
// Au démarrage, les lots restés « en génération » après un arrêt brutal sont remis en file :
// ils seront repris avec les mêmes billets.

import { db } from "../src/lib/db";
import { nextQueuedBatch, renderBatch, requeueBatch, WORKER_NAME } from "../src/lib/batches";

const POLL_MS = 1_000;
const HEARTBEAT_MS = 5_000;
let stopping = false;

async function heartbeat(info: Record<string, unknown> = {}) {
  const data = { beatAt: new Date(), info: { pid: process.pid, ...info } };
  await db.serviceHeartbeat.upsert({ where: { name: WORKER_NAME }, update: data, create: { name: WORKER_NAME, ...data } });
}

async function recoverInterrupted() {
  const stuck = await db.batch.findMany({ where: { status: "GENERATING" }, select: { id: true } });
  for (const b of stuck) {
    await requeueBatch(b.id);
    console.log(`Lot ${b.id} interrompu : remis en file.`);
  }
}

async function main() {
  console.log(`Service de génération démarré (pid ${process.pid}).`);
  await recoverInterrupted();
  await heartbeat();
  const hb = setInterval(() => heartbeat().catch((e) => console.error("Signal de vie :", e)), HEARTBEAT_MS);

  while (!stopping) {
    const batchId = await nextQueuedBatch().catch((e) => {
      console.error("File d'attente :", e);
      return null;
    });
    if (!batchId) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      continue;
    }
    const t0 = Date.now();
    try {
      const b = await renderBatch(batchId);
      console.log(`Lot ${batchId} prêt : ${b.quantity} billets, ${b.pageCount} pages, ${Date.now() - t0} ms.`);
    } catch (e) {
      console.error(`Lot ${batchId} en échec :`, e instanceof Error ? e.message : e);
    }
  }
  clearInterval(hb);
  await db.$disconnect();
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    // Un lot en cours sera remis en file au prochain démarrage.
    console.log("Arrêt du service de génération.");
    stopping = true;
    process.exit(0);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
