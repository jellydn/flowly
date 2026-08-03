#!/usr/bin/env bash
# Day 30 capstone demo launcher.
#
# Demonstrates the complete end-to-end flow:
#   repository → indexing → RAG retrieval → tool execution → cited answer → eval
#
# Usage:
#   demo/capstone-demo.sh           # human-readable
#   demo/capstone-demo.sh --json    # machine-readable JSON output

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${REPO_ROOT}"
exec npx tsx demo/capstone-demo.ts "$@"
