#!/usr/bin/env bash
# Deterministic repository-analysis demo.
#
# Runs a deterministic investigation loop (no LLM required) against the
# bundled fixture repository. Shows how the agent combines search_docs,
# search_code, and read_file to produce grounded answers with citations.
#
# Usage:
#   demo/repository-analysis.sh              # all scenarios
#   demo/repository-analysis.sh auth         # only auth-related scenarios
#   demo/repository-analysis.sh payment      # only the negative-search scenario

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${REPO_ROOT}"
exec npx tsx demo/repository-analysis.ts "$@"
