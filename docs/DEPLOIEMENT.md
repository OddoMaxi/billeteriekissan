# Déploiement et exploitation

## Principe

À chaque **push sur `main`**, GitHub Actions ([.github/workflows/deploy.yml](../.github/workflows/deploy.yml)) :

1. lance les **tests** (TypeScript, lint, 83 tests sur une base PostgreSQL de test) : s'ils échouent, rien n'est déployé ;
2. construit l'**image Docker** et la publie sur le registre GitHub (`ghcr.io/<compte>/<dépôt>`) ;
3. se connecte au **VPS** en SSH, copie `deploy/` dans `/opt/billetterie`, applique les **migrations** de la base
   puis redémarre l'application ; le déploiement échoue si l'application ne répond pas ensuite.

Services sur le VPS ([deploy/docker-compose.yml](../deploy/docker-compose.yml)) :

| Service | Rôle |
| --- | --- |
| `db` | PostgreSQL 16 (volume `pgdata`) |
| `migrate` | applique les migrations avant chaque démarrage |
| `app` | application web (Next.js) |
| `worker` | génération des PDF des lots (un seul exemplaire) |
| `caddy` | HTTPS automatique (Let's Encrypt) devant `app` |
| `backup` | sauvegarde quotidienne à 3 h (base + fichiers), 14 jours conservés |

## Mise en place (une seule fois)

1. **DNS** : un enregistrement `A` du domaine vers l'IP du VPS. Sans domaine, utiliser `<IP>.sslip.io`
   (ex. `203.0.113.10.sslip.io`) : le HTTPS fonctionne aussi. Le HTTPS est obligatoire (cookies de session sécurisés).
2. **VPS** (Ubuntu ou Debian, 2 Go de RAM minimum) :
   ```bash
   scp deploy/bootstrap.sh root@IP:/root/
   ssh root@IP 'DOMAIN="billetterie.exemple.gn, www.billetterie.exemple.gn" bash /root/bootstrap.sh'
   ```
   Le script installe Docker, crée l'utilisateur `deploy`, ouvre les ports 22/80/443, génère les secrets dans
   `/opt/billetterie/.env` et affiche la clé SSH de déploiement.
3. **GitHub** → Settings → Secrets and variables → Actions : `VPS_HOST`, `VPS_USER` (= `deploy`), `VPS_SSH_KEY`
   (clé privée affichée par le script ; la supprimer ensuite du serveur : `rm /home/deploy/.ssh/github_deploy`).
4. **Premier déploiement** : pousser sur `main` (ou Actions → « Tests et déploiement » → Run workflow).
5. **Premier administrateur** :
   ```bash
   ssh deploy@IP
   cd /opt/billetterie
   docker compose run --rm -e ADMIN_EMAIL=admin@exemple.gn -e ADMIN_PASSWORD='mot-de-passe-long' -e ADMIN_NAME="Administrateur" app npx tsx prisma/seed.ts
   ```

> **`QR_ENCRYPTION_KEY`** (dans `/opt/billetterie/.env`) chiffre les valeurs QR conservées pour la réimpression.
> Conservez-en une copie hors du serveur et **ne la changez jamais** après la première génération de billets.

## Opérations courantes

```bash
ssh deploy@IP && cd /opt/billetterie
docker compose ps                      # état des services
docker compose logs -f --tail=100 app  # journaux (app, worker, migrate, caddy, backup)
docker compose restart worker          # relancer le service de génération
ls -lh backups/                        # sauvegardes
```

**Revenir à une version précédente** : dans `.env`, remplacer `IMAGE_TAG` par l'empreinte du commit voulu
(liste dans l'onglet Actions de GitHub), puis `docker compose up -d`. Si des migrations ont été appliquées entre-temps,
restaurer aussi la sauvegarde correspondante.

**Restaurer une sauvegarde** :

```bash
docker compose stop app worker
docker compose exec -T db pg_restore --clean --if-exists -U billetterie -d billetterie < backups/base-AAAA-MM-JJ_HHMM.dump
docker run --rm -v billetterie_storage:/storage -v "$PWD/backups:/b" alpine sh -c "rm -rf /storage/* && tar -xzf /b/fichiers-AAAA-MM-JJ_HHMM.tar.gz -C /storage"
docker compose start app worker
```

Tester cette restauration au moins une fois avant le premier événement réel (exigence de la section 11).

## Le jour d'un événement

- **Ne pas pousser sur `main` pendant l'ouverture des portes** : un déploiement redémarre l'application
  (quelques secondes d'indisponibilité, affichées « CONNEXION INDISPONIBLE » sur les postes de contrôle).
- Générer les gros lots de billets à l'avance : le rendu ne ralentit pas les scans (service séparé), mais
  consomme du processeur.
- Vérifier la veille : `docker compose ps` (tous les services « healthy » ou « running »), dernière sauvegarde présente.
