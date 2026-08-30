---
page: benchmark
layout: standard
---
Build `docs/benchmark.html`, a reference page for the model evaluation
benchmark (`eval/bench`). Same single-file pattern as `docs/index.html` —
copy the header/nav/footer from `docs/index.html` verbatim and mark
"Benchmark" (or "Docs") as the active section. Update the nav on
`docs/index.html` too if a new link is added, and keep the design system
exact (dark, amber + teal, JetBrains Mono).

Keep the current product framing: Flowly is factory software that users run
against a configured GitHub repository. Explain the benchmark as evidence for
choosing models for that factory; do not imply that Flowly is a hosted service,
installs itself into repositories, or auto-merges and auto-approves changes.

Facts to cover (verify against `eval/README.md` and `scripts/flue-eval.ts`):
- ORI-Eval-inspired framework; 7 capstone scenarios; deterministic mode needs
  no LLM key (safe for CI); `--live` uses an OpenAI-compatible client.
- CLI: `npm run eval -- run | compare | leaderboard | report | review`.
- Scoring: quality 0..1 from tool success, citation accuracy, retrieval
  relevance, answer completeness; keyword judge by default, LLM judge seam.
- Provider usage: prefers provider-reported tokens + billed cost, falls back
  to the pricing table; each report records `usageSource`.
- Human-acceptance flow: `npm run eval -- review <runId> --accept ...`.
- Suite format: `suite` (scenarios + expected sources/keywords) + `models`;
  results persist under `eval/results/`.

**DESIGN SYSTEM (REQUIRED):**
[Copy from `.design/DESIGN.md` Section 6]

**Page Structure:**
1. Header/nav/footer copied from `docs/index.html`
2. Hero: "Benchmark your model. Trust the numbers."
3. Quick-reference: the five CLI subcommands as cards
4. Scenario table (7 capstone scenarios with expected tool patterns)
5. Scoring section with the four dimensions + judge explanation
6. Provider usage + `usageSource` explainer
7. Human-acceptance review flow (step-by-step)
8. Suite JSON structure example
9. Link back to `index.html` and the ADR `0002-model-eval-benchmark`
