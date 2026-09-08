# Sherpa documentation

Code is the source of truth. These documents describe what the code doesn't explain: why the system works this way, which invariants it maintains, what was decided and why. Contracts (schemas, interfaces, constants) aren't duplicated. Each document links to their file in `packages/protocol` or `packages/server`.

## Contents

| Document | Contents |
|---|---|
| [`product.md`](product.md) | Product: problem, principles, glossary, main screen, scenarios, functional requirements, out of scope |
| [`architecture.md`](architecture.md) | System: packages and roles, data flow, storage, route orchestrator, `ReviewHost` and `HostCapabilities`, non-functional requirements, invariants |
| [`protocol.md`](protocol.md) | Session↔server protocol: constraints, CLI, tasks, queue, liveness, discovery, versions, endpoint table |
| [`decisions.md`](decisions.md) | Decision log by subsystem. Record each new decision here |
| [`testing.md`](testing.md) | Required checks, unit tests, host contract suite, e2e, performance budgets, state gallery |
| [`design/`](design/) | Design handoff: `README.md` (screens, tokens, state model), `SPEC-elements.md` (element behaviour, keyboard), `SPEC-additions-2026-08-26.md`, `SPEC-onboarding-2026-09-02.md`, `*.dc.html` prototypes |
| [`research/`](research/) | Research: review host API, difftastic |

## Precedence when documents conflict

`product.md` → `design/SPEC-elements.md` → `design/README.md` → the `design/Sherpa.dc.html` prototype. The prototype is a reference, not source code.

When a document disagrees with the code, the code is right and the document needs fixing.

## References from code

References in comments use a path from the repository root and a section: `docs/protocol.md §7`, `docs/design/SPEC-elements.md §2.6`, `docs/product.md §3`. Section numbering in `product.md` and `protocol.md` is stable. New sections go at the end, not in the middle.

## Style

Short paragraphs, facts, numbers. Skip filler ("it is important to note", "it should be stressed"), descriptions of what the code already says, and development history. Who did what, when and in what order belongs in `decisions.md`, and only where it explains a decision.
