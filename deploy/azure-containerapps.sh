#!/usr/bin/env bash
#
# Deploy the internal-messaging app to Azure Container Apps (Consumption plan)
# on your own subdomain, backed by your existing Azure Database for MySQL.
#
# This script contains NO secrets. You provide them via environment variables
# in your own shell (see the "Credentials" section in README.md). Nothing
# sensitive is written to the repo.
#
# Prerequisites:
#   - az CLI installed and logged in:   az login
#   - az containerapp extension:        az extension add --name containerapp
#
# Required env vars (set these in your shell before running):
#   DATABASE_URL  e.g. mysql+pymysql://USER:PASSWORD@HOST.mysql.database.azure.com:3306/DBNAME
#
# Optional env vars (sensible defaults below):
#   RG, LOCATION, ACR, APP, ENVIRONMENT, IMAGE_TAG, CUSTOM_DOMAIN
#
set -euo pipefail

# ---- Config (override via env) ---------------------------------------------
RG="${RG:-rg-internal-messaging}"
LOCATION="${LOCATION:-centralindia}"
ACR="${ACR:-kouzinamsg$RANDOM}"          # ACR names must be globally unique
APP="${APP:-internal-messaging}"
ENVIRONMENT="${ENVIRONMENT:-msg-env}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
IMAGE="$ACR.azurecr.io/internal-messaging:$IMAGE_TAG"
CUSTOM_DOMAIN="${CUSTOM_DOMAIN:-}"        # e.g. chat.example.com (optional)

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "ERROR: set DATABASE_URL in your shell first (it is NOT stored in this repo)." >&2
  exit 1
fi

echo ">> Resource group"
az group create -n "$RG" -l "$LOCATION" -o none

echo ">> Container registry: $ACR"
az acr create -g "$RG" -n "$ACR" --sku Basic --admin-enabled true -o none

echo ">> Build image in the cloud (no local Docker needed)"
# Runs the build on ACR from the repo root, so run this script from the repo root.
az acr build -r "$ACR" -t "internal-messaging:$IMAGE_TAG" . -o none

echo ">> Container Apps environment"
az containerapp env create -g "$RG" -n "$ENVIRONMENT" -l "$LOCATION" -o none

ACR_USER=$(az acr credential show -n "$ACR" --query username -o tsv)
ACR_PASS=$(az acr credential show -n "$ACR" --query 'passwords[0].value' -o tsv)

echo ">> Deploy / update the container app"
az containerapp create \
  -g "$RG" -n "$APP" \
  --environment "$ENVIRONMENT" \
  --image "$IMAGE" \
  --registry-server "$ACR.azurecr.io" \
  --registry-username "$ACR_USER" \
  --registry-password "$ACR_PASS" \
  --target-port 8000 \
  --ingress external \
  --min-replicas 0 \
  --max-replicas 2 \
  --secrets "db-url=$DATABASE_URL" \
  --env-vars "DATABASE_URL=secretref:db-url" "PORT=8000" \
  -o none

FQDN=$(az containerapp show -g "$RG" -n "$APP" --query properties.configuration.ingress.fqdn -o tsv)
echo ">> Live at: https://$FQDN"

# ---- Optional: bind your custom subdomain with a free managed cert ----------
if [[ -n "$CUSTOM_DOMAIN" ]]; then
  echo
  echo ">> Custom domain: $CUSTOM_DOMAIN"
  echo "   Add these DNS records at your registrar, then re-run with CUSTOM_DOMAIN set:"
  echo "     CNAME  ${CUSTOM_DOMAIN%%.*}        $FQDN"
  echo "     TXT    asuid.${CUSTOM_DOMAIN%%.*}  <value below>"
  ASUID=$(az containerapp show -g "$RG" -n "$APP" --query properties.customDomainVerificationId -o tsv)
  echo "     asuid TXT value: $ASUID"
  echo
  echo "   Once DNS has propagated, binding with a free managed certificate:"
  az containerapp hostname add -g "$RG" -n "$APP" --hostname "$CUSTOM_DOMAIN" -o none || true
  az containerapp hostname bind -g "$RG" -n "$APP" \
    --hostname "$CUSTOM_DOMAIN" \
    --environment "$ENVIRONMENT" \
    --validation-method CNAME -o none || \
    echo "   (If binding failed, DNS likely hasn't propagated yet — re-run later.)"
  echo ">> Custom domain configured: https://$CUSTOM_DOMAIN"
fi
