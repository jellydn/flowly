# Architecture Decision Records

This directory records significant architecture decisions for **Flowly**
using the [ADR](https://github.com/joelparkerhenderson/architecture-decision-record)
format. Each record captures the context, the decision, and the consequences.

## Index

| ADR | Title | Status |
| --- | ----- | ------ |
| [0001](./0001-event-router.md) | GitHub event router for agent dispatch | Accepted |
| [0002](./0002-model-eval-benchmark.md) | Model evaluation benchmark framework | Accepted |
| [0003](./0003-tool-composition-seam.md) | Tool composition seam for the inspection tool set | Accepted |
| [0004](./0004-live-eval-provider-seam.md) | Live-eval provider seam | Accepted |

## Codebase map

ADR records capture *why* a decision was made. For the *current* state of the
codebase — layers, data flow, entry points, conventions, and concerns — see the
[codebase map](../../.planning/codebase/), especially the Decisions section of
[ARCHITECTURE.md](../../.planning/codebase/ARCHITECTURE.md). When a decision
changes the architecture, update both the ADR and the map so the two
documentation systems stay consistent.

## Conventions

- Number ADRs sequentially; never reuse or renumber.
- Status values: `Proposed`, `Accepted`, `Deprecated`, `Superseded by ADR-N`.
- Add a row to the index above for every new record.
- Records are immutable once `Accepted` — record later changes in a new ADR.
- Cross-link with the codebase map: record the decision here and reflect it in
  `.planning/codebase/` (ARCHITECTURE.md Decisions section).

## Creating a new ADR

```bash
cp docs/adr/template.md docs/adr/0005-your-title.md
# fill in Context / Decision / Consequences, then add it to the index
# and cross-link it from .planning/codebase/ARCHITECTURE.md
```
