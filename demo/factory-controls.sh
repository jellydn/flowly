#!/usr/bin/env bash
# Show factory capability, workspace, security, verification, review, and operator controls.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${REPO_ROOT}"
exec npx tsx demo/factory-controls.ts "$@"
