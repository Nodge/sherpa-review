# Sherpa documentation

The code is the source of truth. These documents cover what the code cannot tell you: why the system is designed this way, which invariants hold, and what was decided and why. Where a contract exists (a schema, an interface, a constant), the documents point to it in `packages/protocol` or `packages/server` instead of repeating it.

## Where to start

For the review controls, read [`guide.md`](guide.md). For configuration and troubleshooting, read [`operations.md`](operations.md). If you want to understand the product, read [`product.md`](product.md). If you want to change the code, read [`architecture.md`](architecture.md) and then the part of [`protocol.md`](protocol.md) that your change touches. Before you commit, [`testing.md`](testing.md) says which checks must pass.

| Document | What it covers |
|---|---|
| [`guide.md`](guide.md) | The user guide: views, the route, the test digest, comments, the agent chat, keyboard shortcuts and settings |
| [`operations.md`](operations.md) | Requirements, configuration, network access, storage and troubleshooting |
| [`product.md`](product.md) | The product: the problem, principles, glossary, main screens, end-to-end scenarios, v1 functionality and what is out of scope |
| [`architecture.md`](architecture.md) | The system: packages and roles, data flow, storage, the route orchestrator, `ReviewHost` and `HostCapabilities`, non-functional requirements, invariants |
| [`protocol.md`](protocol.md) | The session and server protocol: constraints, the CLI, tasks, the queue, liveness, discovery, versions and the endpoint table |
| [`decisions.md`](decisions.md) | The decision log by subsystem. Every new decision goes here |
| [`testing.md`](testing.md) | Checks, unit tests, the host contract suite, e2e, performance budgets and the state gallery |
| [`i18n-glossary.md`](i18n-glossary.md) | The UI glossary: one English term per concept, the starting point for a new UI translation |
| [`design/`](design/) | The design handoff: `README.md` (screens, tokens, state model), `SPEC-elements.md` (element behaviour and the keyboard), the dated `SPEC-additions-2026-08-26.md`, `SPEC-onboarding-2026-09-02.md`, `SPEC-theming-2026-09-12.md` and `SPEC-changes-2026-09-20.md`, and the `*.dc.html` prototypes |
| [`research/`](research/) | Research notes: the GitHub API, difftastic, and waiting for tasks in agent harnesses |

## When documents disagree

The order of precedence is `product.md`, then `design/SPEC-elements.md`, then `design/README.md`, then the `design/Sherpa.dc.html` prototype. The prototype is a reference, not source code.

If a document disagrees with the code, the code is right. Fix the document.

## How code refers to these documents

A comment names the path from the repository root and a section: `docs/protocol.md §7`, `docs/design/SPEC-elements.md §2.6`, `docs/product.md §3`. The section numbers in `product.md` and `protocol.md` are stable, so a new section goes at the end and never in the middle.

## Style

Short paragraphs, facts and numbers. Leave out filler ("it is important to note", "it should be stressed"), descriptions of what the code already says, and development history. Who did what, when and in what order belongs in `decisions.md`, and only where it explains a decision.
