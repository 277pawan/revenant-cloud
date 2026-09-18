#!/usr/bin/env bash
# Deploy Revenant API to Google Cloud Run (project: revenant-cloud)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PROJECT_ID="${PROJECT_ID:-revenant-cloud}"
REGION="${REGION:-asia-south1}"
SERVICE="${SERVICE:-revenant-api}"

echo "==> Project: $PROJECT_ID | Region: $REGION | Service: $SERVICE"

if ! command -v gcloud >/dev/null 2>&1; then
  echo "Install gcloud: https://cloud.google.com/sdk/docs/install"
  exit 1
fi

# Login only if not already authenticated
if ! gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null | grep -q .; then
  gcloud auth login
fi

gcloud config set project "$PROJECT_ID"
gcloud config set run/region "$REGION"

echo "==> Checking billing..."
BILLING_ENABLED="$(gcloud billing projects describe "$PROJECT_ID" --format='value(billingEnabled)' 2>/dev/null || echo false)"
if [[ "$BILLING_ENABLED" != "True" ]]; then
  echo ""
  echo "ERROR: Billing is NOT enabled on project '$PROJECT_ID'."
  echo ""
  echo "Cloud Run requires an active billing account. Fix this first:"
  echo "  1. Open: https://console.cloud.google.com/billing/linkedaccount?project=$PROJECT_ID"
  echo "  2. Link a billing account with a valid payment method"
  echo "     (your listed accounts may be closed — create or reopen one)"
  echo "  3. Re-run: ./scripts/deploy-cloud-run.sh"
  echo ""
  echo "Or from CLI after billing account is open:"
  echo "  gcloud billing accounts list"
  echo "  gcloud billing projects link $PROJECT_ID --billing-account=BILLING_ACCOUNT_ID"
  exit 1
fi

echo "==> Enabling APIs..."
gcloud services enable run.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com --quiet

echo "==> Local build check..."
npm run build

echo "==> Deploying from source (uses Dockerfile)..."
gcloud run deploy "$SERVICE" \
  --source . \
  --region "$REGION" \
  --allow-unauthenticated \
  --port 8080 \
  --min-instances=0 \
  --max-instances=3 \
  --memory=512Mi \
  --cpu=1

URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')"
echo ""
echo "Deployed: $URL"
echo "Test: curl $URL/health"
echo ""
echo "Set production env (use Secret Manager for DATABASE_URL / JWT_SECRET / MASTER_KEY):"
echo "  gcloud run services update $SERVICE --region $REGION \\"
echo "    --set-env-vars NODE_ENV=production,API_HOST=0.0.0.0,COOKIE_SECURE=true,EMBEDDED_RUNNER=false,EMBEDDED_SCHEDULER=false,CORS_ORIGIN=https://revenant-cloud.web.app,https://revenant-cloud.firebaseapp.com,PUBLIC_APP_URL=https://revenant-cloud.web.app,OAUTH_REDIRECT_BASE_URL=$URL"
echo ""
echo "Then update revenant-cloud-web/.env.production:"
echo "  VITE_API_URL=$URL"
echo ""
echo "Run migrations against HOSTED Postgres (not localhost):"
echo "  DATABASE_URL='postgresql://...' npm run db:migrate"
