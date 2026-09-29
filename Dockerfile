# Image unique de la billetterie : serveur web (next start) et service de génération des PDF (worker).
# Construite par GitHub Actions et publiée sur GHCR ; voir deploy/ et .github/workflows/deploy.yml.

FROM node:24-bookworm-slim AS base
# OpenSSL : requis par le moteur de requêtes Prisma.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# ─── Dépendances et construction ────────────────────────────────────────────
FROM base AS build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npx prisma generate
# Aucune connexion à la base pendant la construction (pages dynamiques) ; URL factice pour Prisma.
ENV NEXT_TELEMETRY_DISABLED=1 DATABASE_URL="postgresql://build:build@localhost:5432/build"
RUN npm run build
# Dépendances de production seulement (Prisma CLI et tsx restent : migrations et worker).
RUN npm prune --omit=dev --ignore-scripts

# ─── Image d'exécution ──────────────────────────────────────────────────────
FROM base AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0 STORAGE_DIR=/app/storage
RUN groupadd --system --gid 1001 app && useradd --system --uid 1001 --gid app app \
  && mkdir -p /app/storage && chown app:app /app/storage
COPY --from=build --chown=app:app /app/package.json /app/package-lock.json /app/next.config.ts /app/tsconfig.json ./
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/.next ./.next
COPY --from=build --chown=app:app /app/public ./public
COPY --from=build --chown=app:app /app/prisma ./prisma
COPY --from=build --chown=app:app /app/src ./src
COPY --from=build --chown=app:app /app/scripts ./scripts
USER app
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npx", "next", "start"]
