#!/usr/bin/env bash
# Run the Day 30 capstone evaluation suite.
#
# The deterministic mode runs without an LLM key — it uses mock decision
# functions that simulate the expected tool sequence for each question.
# Failures are visible (non-zero exit code) rather than silently ignored.
#
# Usage:
#   eval/run-capstone-eval.sh           # deterministic, human-readable
#   eval/run-capstone-eval.sh --json    # machine-readable JSON output
#
# For live agent evaluation, use:
#   REPOSITORY_PATH=eval/fixtures/sample-repo REPO_ASSISTANT_DEBUG=true \
#     npm start -- --input '{"message":"<question>"}'

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${REPO_ROOT}"
exec npx tsx eval/capstone-eval.ts "$@"
