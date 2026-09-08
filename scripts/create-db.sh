#!/usr/bin/env bash
# Create control-plane database on local Postgres (no Docker).
set -euo pipefail

PGUSER="${PGUSER:-postgres}"
PGHOST="${PGHOST:-localhost}"
PGPORT="${PGPORT:-5432}"

echo "Creating database revenant_cloud (user: $PGUSER)..."
psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -tc "SELECT 1 FROM pg_database WHERE datname = 'revenant_cloud'" | grep -q 1 \
  || psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -c "CREATE DATABASE revenant_cloud;"

echo "Done. Set DATABASE_URL=postgresql://postgres:root@localhost:5432/revenant_cloud"
