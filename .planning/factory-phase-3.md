# Factory Phase 3 stack — independent review + draft PR

Part of [#94](https://github.com/jellydn/flowly/issues/94). Phase 1 (orchestration)
and Phase 2 (isolated git + verification) are on `main`. This stack adds the
independent reviewer and trusted draft-PR publisher.

## Layers

```text
(main)
  <- cursor/factory-review-3e30      isolated review evidence + AC verdicts
  <- cursor/factory-publisher-3e30   trusted draft PR publisher (never merge)
  <- cursor/factory-pipeline-3e30    review→PR coordinator, factory event route, docs
```

1. **Review isolation** — build reviewer input from the issue, acceptance
   criteria, real diff, and structured verification only. Strip implementer
   scratch. Map judgments onto `ReviewVerdict`.
2. **Draft PR publisher** — create one draft PR on a factory-owned branch
   through a trusted GitHub adapter. Never approve or merge. Reuse an existing
   PR for the same head.
3. **Pipeline + route** — run review then publish after verification, route
   `issues.labeled.factory`, and document the trust boundary.
