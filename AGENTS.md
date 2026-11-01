# Sherpa rules for agents

A local code review tool. The reviewer reads a PR diff in the browser, while an AI agent in the same harness builds a route through the diff and answers questions. Seven packages in a pnpm monorepo under `packages/` (`protocol`, `server`, `ui`, `cli`, `skill`, `fixtures`, `e2e`), TypeScript throughout, Node ≥ 22.13. See `docs/architecture.md` for the system design and `CONTRIBUTING.md` for running, building and testing.

## Source of truth

Code. The documents in `docs/` describe what the code cannot tell you: the product, invariants, protocol and decisions. When documents disagree, follow `docs/product.md` → `docs/design/SPEC-elements.md` → `docs/design/README.md` → the prototype in `docs/design/Sherpa.dc.html`. The prototype is a reference, not a source of code. Do not implement the SCENARIOS button.

Record any decision that changes behaviour, a contract or an invariant in `docs/decisions.md` (subsystem section, date, what and why). Mark a superseded decision as superseded, without deleting it. Each entry records a decision in 1–3 sentences: what was decided, why, and what it constrains going forward. Implementation progress, measurements, file lists, line numbers and lists of completed work belong in the code and PR, not here.

## Checks

Before every commit, `pnpm -r typecheck && pnpm -r lint && pnpm -r test` must pass. E2E (`pnpm --filter @sherpa/e2e e2e`) is outside the required checks. Run it before a release and after changes to `packages/e2e`, the server or UI flows covered by e2e.

## Contracts

- Everything the model reads or that crosses a process boundary has a schema in `packages/protocol` and passes validation. The UI consumes only data that passes its schema. The server rejects task results that fail validation (fail closed).
- Review hosts and update and feedback channels are plugins registered through the composition roots in `packages/server/src/hosts/all.ts` and `packages/cli/src/hosts/all.ts`. The core does not know hosts by name. Host-specific behaviour stays inside the `ReviewHost` adapter (`packages/protocol/src/review-host.ts`). A new host method needs a flag in `HostCapabilities` and a check in the contract test suite at `packages/server/src/hosts/review-host-contract.ts`.

- The CLI is one self-contained `.mjs` with no runtime dependencies. The server is one bundle with the UI embedded. Any new dependency in `cli` or `server` must be bundled by esbuild.
- Increment the protocol version (`packages/protocol/src/version.ts`) whenever worker endpoints or the task format change incompatibly.

## Language

Write all project text in English, including SKILL.md, CLI output, task text, HTTP errors, UI text, `server.log`, code comments and documentation. The loop markers ("stop the loop", "DONE") are a contract between the `sherpa-review guide` text and the rest of the CLI output, covered by a test in `packages/cli` (`guide.test.ts`).

Text the reviewer reads (UI, route text, release `--notes` in the update toast) describes what they see on screen, using their vocabulary: "context expansion is no longer blocked by changes outside your ownership zone" → "the arrows that reveal hidden diff lines work again in the route".

## UI

A test compares the design tokens in `packages/ui/src/styles/tokens.css` with 2 documents: geometry, fonts and motion against `docs/design/README.md`, and colours in both themes against `docs/design/theme.md`. The state gallery (`packages/ui/gallery.html`, `src/dev/gallery/`) renders every screen state using fixtures from `@sherpa/fixtures`. A new state or component needs a new gallery card. Verify appearance with the gallery beside the prototype in the same viewport, until they match.
