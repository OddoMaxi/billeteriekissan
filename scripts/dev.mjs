// Développement : lance le serveur Next.js et le service de génération ensemble.
// Les arguments sont transmis à « next dev » (ex. npm run dev -- -p 3100).
// Un arrêt du service de génération n'arrête pas le serveur web (les lots restent en file).
import { spawn } from "node:child_process";

const web = spawn("npx", ["next", "dev", ...process.argv.slice(2)], { stdio: "inherit" });
const worker = spawn("npx", ["tsx", "watch", "--conditions=react-server", "--env-file=.env", "scripts/worker.ts"], { stdio: "inherit" });

const stop = () => [web, worker].forEach((p) => p.kill("SIGTERM"));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
worker.on("exit", (code) => console.warn(`Service de génération arrêté (code ${code}). Relancez-le avec « npm run worker ».`));
web.on("exit", (code) => {
  worker.kill("SIGTERM");
  process.exitCode = code ?? 0;
});
