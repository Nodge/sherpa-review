# Sherpa rules for agents

A local code review tool. The reviewer reads a PR diff in the browser, while an AI agent in the same harness builds a route through the diff and answers questions. Seven packages in a pnpm monorepo under `packages/` (`protocol`, `server`, `ui`, `cli`, `skill`, `fixtures`, `e2e`), TypeScript throughout, Node ≥ 22.13. See `docs/architecture.md` for the system design and `CONTRIBUTING.md` for running, building and testing.

## Source of truth

Code. Documents in `docs/` describe what code cannot show: product, invariants, protocol, decisions. When documents conflict: `docs/product.md` → `docs/design/SPEC-elements.md` → `docs/design/README.md` → the `docs/design/Sherpa.dc.html` prototype. The prototype is a reference, not a code source. Its SCENARIOS button is not implemented.

Record any decision that changes behaviour, a contract or an invariant in `docs/decisions.md` (subsystem section, date, what and why). Mark an overturned decision as superseded. Do not delete it.

## Checks

Before every commit, `pnpm -r typecheck && pnpm -r lint && pnpm -r test` must pass. E2E (`pnpm --filter @sherpa/e2e e2e`) is not a required check. Run it before a release and after changes to `packages/e2e`, the server or UI flows covered by e2e.

## Contracts

- Everything the model reads or that crosses a process boundary has schemas in `packages/protocol` and passes validation. The UI consumes nothing that has not passed a schema. Task results that fail validation are rejected (fail-closed).
- Host-specific code stays behind the `ReviewHost` adapter (`packages/protocol/src/review-host.ts`). Every new host method needs a flag in `HostCapabilities` and a check in the contract suite at `packages/server/src/hosts/review-host-contract.ts`.
- The CLI is one self-contained `.mjs` with no runtime dependencies. The server is one bundle with the UI embedded. Any new dependency in `cli` or `server` must be bundled by esbuild.
- Increment the protocol version (`packages/protocol/src/version.ts`) whenever worker endpoints or the task format change incompatibly.

## Language

Everything the model reads (SKILL.md, CLI output, task text, HTTP errors from worker endpoints) is in English. UI, `server.log`, code comments and docs are in Russian. Loop markers ("stop the loop", "No tasks", "DONE") are a contract between SKILL.md and the code, enforced by a test in `packages/skill`.

## UI

A test checks design tokens in `packages/ui/src/styles/tokens.css` against `docs/design/README.md`. Each screen state renders in the state gallery (`packages/ui/gallery.html`, `src/dev/gallery/`) using fixtures from `@sherpa/fixtures`. A new state or component needs a new gallery card. Accept the appearance by comparing the gallery beside the prototype at the same viewport size until they match.
