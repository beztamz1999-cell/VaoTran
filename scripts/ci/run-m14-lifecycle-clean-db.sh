#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DB_NAME="${VT_CI_DB_NAME:-vaotran_m14_ci}"
SOCKET_DIR="${PGHOST:-/var/run/postgresql}"
DB_URL="postgresql://ubuntu@/${DB_NAME}?host=${SOCKET_DIR}"

cleanup() { dropdb --if-exists "$DB_NAME"; }
trap cleanup EXIT
dropdb --if-exists "$DB_NAME"
createdb "$DB_NAME"
cd "$ROOT_DIR"
DATABASE_URL="$DB_URL" ./node_modules/.bin/tsx src/platform/database/migrate.ts up
DATABASE_URL="$DB_URL" ./node_modules/.bin/vitest run src/tests/m14-operational.integration.test.ts --no-file-parallelism
