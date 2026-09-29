# Billetterie physique

Création, impression et contrôle de billets physiques à QR code (cahier des charges V1.2).
Next.js 16 (App Router) · TypeScript · Prisma · PostgreSQL.

## Décisions par rapport au cahier des charges

- **5 tickets par feuille A4** (au lieu de 4) : ticket nominal **210 × 59,4 mm**. Chaque lot enregistre
  son nombre de tickets par page, pour que la réimpression d'un lot reproduise exactement le fichier d'origine.
- Activation au contrôle : billet **vendu** ou **activé par lot** (les deux restent distincts dans les rapports).
- Choix par défaut de l'étape 4 (section 15, modifiables) :
  - un billet remis reste **en attente** jusqu'à l'accusé de réception du destinataire ; un refus le renvoie à l'émetteur ;
  - **remise vendeur** plafonnée par billet selon la catégorie (0 par défaut) ; organisateur et gestionnaire peuvent dépasser, avec motif ;
  - **corrections de vente** (erreur de saisie, annulation avec remboursement) réservées à l'organisateur et au gestionnaire ;
  - **versements** déclarés par le vendeur, validés par l'organisateur ou le gestionnaire (jamais par le déclarant).
- Ventes et journal d'audit **en ajout seul, garanti par la base** (déclencheurs PostgreSQL) : une correction est une contre-écriture.

- **Numérotation propre à chaque catégorie** (26/09/2026) : 001, 002… 999, 1000… sans retour à zéro.
  Le même numéro existe donc dans plusieurs catégories : les opérations de stock et de vente se font
  par catégorie, et la saisie manuelle accepte « VIP 012 ». Les QR restent uniques et aléatoires.

## Démarrage

```bash
cp .env.example .env            # puis renseigner DATABASE_URL et QR_ENCRYPTION_KEY
npm install
npx prisma migrate dev          # crée le schéma
ADMIN_EMAIL=admin@exemple.gn ADMIN_PASSWORD='motdepasse-long' npm run db:seed
npm run dev                     # serveur web + service de génération des PDF
```

## Contrôle d'entrée

- Le flasheur Bluetooth est configuré **en mode clavier avec le suffixe Entrée** ; le champ de lecture reste toujours actif.
- Contrôle **en ligne obligatoire** (V1) : sans réponse du serveur, l'écran affiche « CONNEXION INDISPONIBLE »,
  jamais « valide » ; la même lecture peut être renvoyée au retour du réseau sans risque de double comptage.
- Recette de charge (serveur de développement, poste unique) : 20 contrôleurs, 10 000 billets, 3 000 lectures
  à ~100 lectures/s : **p95 = 69 ms**, aucune double admission.

> Après une migration de la base (`npx prisma migrate dev`), redémarrez `npm run dev` : le serveur garde
> sinon l'ancien client Prisma en mémoire.

## Déploiement

Docker (application, service de génération, PostgreSQL, HTTPS Caddy, sauvegardes) ; déploiement automatique
à chaque push sur `main` après les tests. Procédure complète : [docs/DEPLOIEMENT.md](docs/DEPLOIEMENT.md).

## Architecture d'exécution

Deux processus :

- **le serveur web** (Next.js) : écrans, API, contrôle d'entrée ;
- **le service de génération** (`npm run worker`) : rend les PDF des lots mis en file par le serveur web.
  Le rendu de 10 000 billets demande quelques secondes de calcul ; isolé dans ce service, il ne ralentit
  jamais les scans (mesure : 73 ms de latence pendant une génération, contre 780 ms dans le même processus).

En production, lancez **un seul** exemplaire du service, supervisé (systemd, pm2…). S'il s'arrête,
les lots restent en file et sont repris au redémarrage avec les mêmes billets.

## Scripts

| Commande            | Rôle                                  |
| ------------------- | ------------------------------------- |
| `npm run dev`       | développement : serveur web + service de génération |
| `npm run worker`    | service de génération seul            |
| `npm test`          | tests unitaires et d'intégration (base `billetterie_test`) |
| `npm run typecheck` | vérification TypeScript               |
| `npm run lint`      | ESLint                                |
| `npm run db:seed`   | premier administrateur + profil d'impression |

## Organisation du code

- `prisma/schema.prisma` : modèle de données (sections 4, 9 et 10 du cahier).
- `src/lib/auth.ts` : sessions en base, relues à chaque requête (révocation immédiate).
- `src/lib/authz.ts` : table des permissions par rôle et par événement ; refus par défaut.
- `src/lib/audit.ts` : journal d'audit, écrit dans la même transaction que l'action.
- `src/lib/numbering.ts` : numérotation visible, planches A4 (5 tickets de 210 × 59,4 mm), découpe en piles.
- `src/lib/crypto.ts` : mots de passe (scrypt), valeurs QR aléatoires, chiffrement AES-GCM.
- `src/lib/template-layout.ts` : zones variables (QR, numéro, talon), disposition proposée et contrôles.
- `src/lib/design-file.ts` : contrôle des designs importés (format, page unique, proportions, résolution).
- `src/lib/render.ts` : rendu PDF (ticket seul, planches A4 de 5 tickets, repères de coupe).
- `src/lib/batches.ts` : réservation des numéros, création des billets, rendu, reprise, réimpression.
- `scripts/worker.ts` : service de génération (file d'attente des lots).
- `src/lib/stock.ts` : remises, retours, pertes, activation, ventes, contre-écritures, versements, rapprochement.
- `src/lib/scan.ts` : contrôle d'entrée (règles de validation, admission atomique, idempotence, réentrée, dérogation).
- `src/app/(app)/control/[eventId]` : écran du contrôleur (flasheur Bluetooth en mode clavier, verdict plein écran, son, témoin réseau).
- `src/lib/reports.ts` : indicateurs de la section 8 (billets par catégorie, recettes, caisses, entrées, écarts).
- `src/lib/exports.ts` : exports CSV (Excel FR), classeur XLSX et rapport de clôture PDF.
- `src/lib/permissions.ts` : table des droits par rôle (module pur, partagé par l'interface et la logique métier).
- `scripts/demo-design.ts` : génère le design de démonstration et le gabarit coté (`npm run design:demo`).

Consignes pour les graphistes : [docs/GABARIT.md](docs/GABARIT.md).

## Avancement (Lot 1)

- [x] Étape 1 : comptes, rôles, organismes, événements, catégories, portes, équipe, audit
- [x] Étape 2 : modèles de billets (import du design, placement QR/numéro, aperçu, BAT, versions, profils d'impression)
- [x] Étape 3 : génération des lots, PDF A4 (5 tickets/page, séquentiel ou piles), manifeste, reprise, réimpression
- [x] Étape 4 : stock, remises avec accusé de réception, ventes déclarées (saisie ou flasheur), contre-écritures, activation, versements, rapprochement
- [x] Étape 5 : contrôle d'entrée (flasheur, verdicts, admission atomique, réentrée, dérogation supervisée, supervision des portes)
- [x] Étape 6 : tableaux de bord (global et par événement), écarts, exports CSV / XLSX et rapport de clôture PDF
