#!/usr/bin/env bash
# Merge production CORS / marketing URLs onto the live Cloud Run service (keeps existing secrets).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT_ID="${PROJECT_ID:-revenant-cloud}"
REGION="${REGION:-asia-south1}"
SERVICE="${SERVICE:-revenant-api}"
ENV_FILE="/tmp/revenant-cloud-run-env.yaml"
SECRETS_FILE="/tmp/revenant-cloud-run-secrets.txt"

CORS_ORIGIN="$(grep -v '^#' "$ROOT/scripts/production-cors.txt" | tr -d '\n' | xargs)"

if [[ -z "$CORS_ORIGIN" ]]; then
  echo "ERROR: production-cors.txt has no CORS value"
  exit 1
fi

echo "==> Updating $SERVICE ($PROJECT_ID / $REGION)"
echo "    CORS_ORIGIN=$CORS_ORIGIN"

python3 - "$PROJECT_ID" "$REGION" "$SERVICE" "$CORS_ORIGIN" "$ENV_FILE" "$SECRETS_FILE" << 'PY'
import json, subprocess, sys, yaml

project, region, service, cors, env_file, secrets_file = sys.argv[1:7]
marketing = "https://revenant-verify-933e4.web.app"
app_url = "https://revenant-cloud-web.web.app"

out = subprocess.check_output([
    "gcloud", "run", "services", "describe", service,
    "--region", region, "--project", project, "--format=json",
])
r = json.loads(out)
container_env = r["spec"]["template"]["spec"]["containers"][0].get("env", [])
env = {}
secret_bindings = []
for item in container_env:
  if "value" in item:
    env[item["name"]] = item["value"]
  secret_ref = item.get("valueSource", {}).get("secretKeyRef")
  if secret_ref:
    secret_bindings.append(
      f"{item['name']}={secret_ref['secret']}:{secret_ref.get('version', 'latest')}"
    )

if not any(binding.startswith("REVENANT_CLI_GITHUB_TOKEN=") for binding in secret_bindings):
  secret_bindings.append(
    "REVENANT_CLI_GITHUB_TOKEN=REVENANT_CLI_GITHUB_TOKEN:latest"
  )
env["CORS_ORIGIN"] = cors
env["PUBLIC_APP_URL"] = app_url
env["PUBLIC_MARKETING_URL"] = marketing
env["PUBLIC_EMAIL_LOGO_URL"] = f"{marketing}/revenant_logo.png"

with open(env_file, "w") as f:
    yaml.dump(env, f, default_flow_style=False)
with open(secrets_file, "w") as f:
    f.write(",".join(secret_bindings))
PY

SECRET_BINDINGS="$(cat "$SECRETS_FILE")"
gcloud run services update "$SERVICE" \
  --region "$REGION" \
  --project "$PROJECT_ID" \
  --env-vars-file "$ENV_FILE" \
  --update-secrets="$SECRET_BINDINGS"

echo "Done."
