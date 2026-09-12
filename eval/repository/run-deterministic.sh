#!/usr/bin/env bash
# Run the deterministic repository-assistant evaluation suite.
#
# The deterministic mode runs without an LLM key — it uses mock decision
# functions that simulate the expected tool sequence for each question.
# Failures are visible (non-zero exit code) rather than silently ignored.
#
# Usage:
#   eval/repository/run-deterministic.sh           # human-readable
#   eval/repository/run-deterministic.sh --json    # machine-readable JSON
#
# For live agent evaluation, use:
#   REPOSITORY_PATH=eval/fixtures/sample-repo REPO_ASSISTANT_DEBUG=true \
#     npm start -- --input '{"message":"<question>"}'

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

cd "${REPO_ROOT}"
exec npx tsx eval/repository/scenarios.ts "$@"
