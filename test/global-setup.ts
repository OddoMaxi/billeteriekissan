import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

// Base de test : TEST_DATABASE_URL (CI) ou la base locale de développement.
const TEST_DB = process.env.TEST_DATABASE_URL ?? "postgresql://ousmaneoddo@localhost:5432/billetterie_test?schema=public";

/** Base de test migrée puis vidée avant la suite ; stockage de test effacé. */
export default async function setup() {
  if (!TEST_DB.includes("_test")) throw new Error("Les tests ne tournent que sur une base *_test.");
  execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: TEST_DB }, stdio: "pipe" });
  const db = new PrismaClient({ datasourceUrl: TEST_DB });
  const tables = await db.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await db.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`);
  await db.$disconnect();
  rmSync(".test-storage", { recursive: true, force: true });
}
