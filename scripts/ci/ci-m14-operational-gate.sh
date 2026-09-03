#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"
./node_modules/.bin/tsc --noEmit
python3 scripts/ci/validate-m14-contract-compatibility.py
bash scripts/ci/run-m14-lifecycle-clean-db.sh
DATABASE_URL="${DATABASE_URL:?DATABASE_URL is required}" ./node_modules/.bin/vitest run src/tests/m14-operational.integration.test.ts --no-file-parallelism
