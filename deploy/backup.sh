#!/bin/sh
# Sauvegarde quotidienne : dump PostgreSQL compressé + archive des fichiers (designs, PDF).
# Restauration : voir docs/DEPLOIEMENT.md.
set -eu
backup() {
  stamp=$(date +%Y-%m-%d_%H%M)
  pg_dump --format=custom --file="/backups/base-$stamp.dump"
  tar -czf "/backups/fichiers-$stamp.tar.gz" -C /storage .
  find /backups -type f -mtime +"$RETENTION_DAYS" -delete
  echo "$(date) sauvegarde $stamp terminée"
}
backup # une sauvegarde au démarrage du service, puis chaque jour à BACKUP_HOUR
while true; do
  now=$(date +%s)
  next=$(date -d "$(date +%Y-%m-%d) ${BACKUP_HOUR}:00" +%s 2>/dev/null || echo $((now + 86400)))
  [ "$next" -le "$now" ] && next=$((next + 86400))
  sleep $((next - now))
  backup || echo "$(date) ÉCHEC de la sauvegarde"
done
