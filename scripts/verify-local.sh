#!/usr/bin/env bash
# Local + Docker verification before Cloud Run deploy
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "[1/4] npm run build"
npm run build

echo "[2/4] Local /health"
fuser -k 8080/tcp 2>/dev/null || true
npm start >/tmp/revenant-api-local.log 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null || true' EXIT
for _ in $(seq 1 15); do
  if curl -sf http://localhost:8080/health; then
    echo ""
    break
  fi
  sleep 1
done
kill $PID 2>/dev/null || true
trap - EXIT

echo "[3/4] docker build"
docker build -t revenant-api .

echo "[4/4] docker /health (production mode)"
docker rm -f revenant-api-test 2>/dev/null || true
docker run -d --name revenant-api-test --network host \
  --env-file .env \
  -e NODE_ENV=production \
  -e EMBEDDED_RUNNER=false \
  -e EMBEDDED_SCHEDULER=false \
  revenant-api
sleep 3
curl -sf http://localhost:8080/health
echo ""
docker rm -f revenant-api-test

echo "[+] npm run db:migrate"
npm run db:migrate

echo "All local checks passed."
