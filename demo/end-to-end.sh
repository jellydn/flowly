#!/usr/bin/env bash
# End-to-end deterministic repository-analysis demo.
#
# Demonstrates the complete end-to-end flow:
#   repository → indexing → RAG retrieval → tool execution → cited answer → eval
#
# Usage:
#   demo/end-to-end.sh           # human-readable
#   demo/end-to-end.sh --json    # machine-readable JSON output

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${REPO_ROOT}"
exec npx tsx demo/end-to-end.ts "$@"
