import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      // « server-only » interdit l'import côté client ; neutre dans les tests.
      "server-only": path.resolve(import.meta.dirname, "test/empty.ts"),
    },
  },
  test: {
    globalSetup: ["test/global-setup.ts"],
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgresql://ousmaneoddo@localhost:5432/billetterie_test?schema=public",
      QR_ENCRYPTION_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
      STORAGE_DIR: "./.test-storage",
    },
    // Les tests d'intégration partagent la même base : exécution séquentielle des fichiers.
    fileParallelism: false,
    testTimeout: 60_000,
  },
});
