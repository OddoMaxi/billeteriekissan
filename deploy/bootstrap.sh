#!/usr/bin/env bash
# Préparation initiale d'un VPS Ubuntu/Debian pour la billetterie. À lancer UNE FOIS, en root :
#   sudo DOMAIN="billetterie.exemple.gn, www.billetterie.exemple.gn" bash bootstrap.sh
# Idempotent : relançable sans rien casser ; les secrets existants ne sont jamais régénérés.
set -euo pipefail

DOMAIN="${DOMAIN:?Indiquez DOMAIN (ou <IP>.sslip.io)}"
DEPLOY_USER="${DEPLOY_USER:-deploy}"
DIR=/opt/billetterie

echo "== Docker"
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker

echo "== Utilisateur de déploiement « $DEPLOY_USER » (clé SSH uniquement)"
id "$DEPLOY_USER" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash "$DEPLOY_USER"
usermod -aG docker "$DEPLOY_USER"
install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh"
KEY="/home/$DEPLOY_USER/.ssh/github_deploy"
if [ ! -f "$KEY" ]; then
  sudo -u "$DEPLOY_USER" ssh-keygen -t ed25519 -N "" -C "github-actions-deploy" -f "$KEY" >/dev/null
  cat "$KEY.pub" >> "/home/$DEPLOY_USER/.ssh/authorized_keys"
  chown "$DEPLOY_USER:$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh/authorized_keys"
  chmod 600 "/home/$DEPLOY_USER/.ssh/authorized_keys"
fi

echo "== Dossier $DIR et secrets"
install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$DIR" "$DIR/backups"
if [ ! -f "$DIR/.env" ]; then
  umask 077
  cat > "$DIR/.env" <<ENV
DOMAIN=$DOMAIN
POSTGRES_PASSWORD=$(openssl rand -hex 24)
# NE JAMAIS CHANGER après la première génération de billets (chiffre les QR conservés pour la réimpression).
QR_ENCRYPTION_KEY=$(openssl rand -base64 32)
ENV
  chown "$DEPLOY_USER:$DEPLOY_USER" "$DIR/.env"
fi

echo "== Pare-feu (SSH, HTTP, HTTPS)"
if command -v ufw >/dev/null; then
  ufw allow OpenSSH >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; ufw allow 443/udp >/dev/null
  ufw --force enable >/dev/null
fi

echo
echo "Prêt. Ajoutez dans GitHub (Settings → Secrets and variables → Actions) :"
echo "  VPS_HOST    = $(curl -fsS https://api.ipify.org || hostname -I | cut -d' ' -f1)"
echo "  VPS_USER    = $DEPLOY_USER"
echo "  VPS_SSH_KEY = contenu de la clé privée ci-dessous (à copier puis à supprimer du serveur) :"
echo "----------------------------------------------------------------"
cat "$KEY"
echo "----------------------------------------------------------------"
echo "Sauvegardez aussi QR_ENCRYPTION_KEY de $DIR/.env en lieu sûr : sans elle, la réimpression est impossible."
