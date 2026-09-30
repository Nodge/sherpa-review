# Sherpa documentation

Code is the source of truth. These documents describe what the code cannot tell you: why the system is designed this way, which invariants hold, and what was decided and why. They link to contracts (schemas, interfaces and constants) in `packages/protocol` or `packages/server` without duplicating them.

## Contents

| Document | Contents |
|---|---|
| [`product.md`](product.md) | Product: problem, principles, glossary, main screen, scenarios, functional requirements, out of scope |
| [`architecture.md`](architecture.md) | System: packages and roles, data flow, storage, route orchestrator, `ReviewHost` and `HostCapabilities`, non-functional requirements, invariants |
| [`protocol.md`](protocol.md) | Session↔server protocol: constraints, CLI, tasks, queue, liveness, discovery, versions, endpoint table |
| [`decisions.md`](decisions.md) | Decision log by subsystem. Record each new decision here |
| [`testing.md`](testing.md) | Checks, unit tests, host contract suite, e2e, performance budgets, state gallery |
| [`design/`](design/) | Design handoff: `README.md` (screens, tokens, state model), `SPEC-elements.md` (element behaviour, keyboard), `SPEC-additions-2026-08-26.md`, `SPEC-onboarding-2026-09-02.md`, `SPEC-theming-2026-09-12.md`, `*.dc.html` prototypes |
| [`research/`](research/) | Research: GitHub API, difftastic, waiting for tasks in harnesses |

## Precedence when documents conflict

`product.md` → `design/SPEC-elements.md` → `design/README.md` → the `design/Sherpa.dc.html` prototype. The prototype is a reference, not source code.

If a document disagrees with the code, the code is right. Fix the document.

## References from code

Use a path from the repository root and a section in comments: `docs/protocol.md §7`, `docs/design/SPEC-elements.md §2.6`, `docs/product.md §3`. Section numbers in `product.md` and `protocol.md` are stable. Append new sections at the end, never insert them in the middle.

## Style

Short paragraphs, facts, numbers. Skip filler ("it is important to note", "it should be stressed"), descriptions of what the code already says, and development history. Who did what, when and in what order belongs in `decisions.md`, and only where it explains a decision.
