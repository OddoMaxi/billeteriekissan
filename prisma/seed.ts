// Crée le premier administrateur central et un profil d'impression par défaut.
// Usage : ADMIN_EMAIL=… ADMIN_PASSWORD=… npx tsx prisma/seed.ts
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../src/lib/crypto";

const db = new PrismaClient();

async function main() {
  const email = (process.env.ADMIN_EMAIL ?? "").trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD ?? "";
  if (!email || password.length < 10) {
    throw new Error("Définissez ADMIN_EMAIL et ADMIN_PASSWORD (10 caractères minimum).");
  }
  const admin = await db.user.upsert({
    where: { email },
    update: {},
    create: { email, name: process.env.ADMIN_NAME ?? "Administrateur", passwordHash: await hashPassword(password), isAdmin: true },
  });
  await db.printProfile.upsert({
    where: { name: "Par défaut (5 mm)" },
    update: {},
    create: { name: "Par défaut (5 mm)" },
  });
  console.log(`Administrateur prêt : ${admin.email}`);
}

main().finally(() => db.$disconnect());
