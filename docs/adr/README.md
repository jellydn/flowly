# Architecture Decision Records

This directory records significant architecture decisions for flue-repo-assistant
using the [ADR](https://github.com/joelparkerhenderson/architecture-decision-record)
format. Each record captures the context, the decision, and the consequences.

## Index

| ADR | Title | Status |
| --- | ----- | ------ |
| [0001](./0001-event-router.md) | GitHub event router for agent dispatch | Accepted |
| [0002](./0002-model-eval-benchmark.md) | Model evaluation benchmark framework | Accepted |

## Conventions

- Number ADRs sequentially; never reuse or renumber.
- Status values: `Proposed`, `Accepted`, `Deprecated`, `Superseded by ADR-N`.
- Add a row to the index above for every new record.
- Records are immutable once `Accepted` — record later changes in a new ADR.

## Creating a new ADR

```bash
cp docs/adr/template.md docs/adr/0003-your-title.md
# fill in Context / Decision / Consequences, then add it to the index
```
