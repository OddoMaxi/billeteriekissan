// Copie le worker de pdf.js dans public/ (servi tel quel, sans passer par le bundler).
import { copyFileSync } from "node:fs";
copyFileSync("node_modules/pdfjs-dist/build/pdf.worker.min.mjs", "public/pdf.worker.min.mjs");
