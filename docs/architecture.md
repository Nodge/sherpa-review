# Sherpa architecture

The system's parts, how data moves between them, what is stored on disk, and the rules that hold throughout the code. Contracts live in `packages/protocol`. This document covers their meaning and boundaries. The session↔server protocol is described separately in `docs/protocol.md`.

## 1. Packages and roles

A pnpm monorepo with 7 packages, TypeScript throughout, Node ≥ 22.13.

| Package | Role |
|---|---|
| `@sherpa/protocol` | Zod schemas and types for everything that crosses boundaries: tasks and RPC messages, the review domain model, the `ReviewHost` interface, route snapshots, UI endpoints and events, the discovery manifest, limits and protocol version. No code with side effects, only schemas and pure checks |
| `@sherpa/server` | Single-PR daemon: HTTP layer, task queue with leases, host adapters, route and chat orchestrators, result validator, storage |
| `@sherpa/ui` | Reviewer's web interface: React 19, Vite build |
| `@sherpa/cli` | The single `sherpa` executable used by the agent |
| `@sherpa/skill` | Harness distribution: `SKILL.md` and `bin/` with 2 bundles |
| `@sherpa/fixtures` | Fixture host and deterministic data for development mode, the state gallery, e2e and performance measurements |
| `@sherpa/e2e` | End-to-end Playwright scenarios and performance measurements |

esbuild builds the **CLI** into one self-contained `.mjs` file. It has no runtime dependencies. Built-in `fetch` and the standard library are enough.

The **server** builds the same way into one ESM file, `sherpa-server.mjs`, with UI assets embedded. `packages/server/build-server.mjs` reads `packages/ui/dist` and replaces `src/ui-assets.ts` with a map of "path inside the build → base64 contents". This map is intentionally empty in source. Development serves the UI from disk, the distribution serves it from memory, and the code has no mode-specific branches.

Storage uses built-in `node:sqlite`. This sets the minimum Node version and lets the server build into a single file with no native dependencies.

SQLite loads on demand through `createRequire`, without a static import. Otherwise, older Node versions would crash with a raw linking error before `checkNodeVersion` (`packages/server/src/runtime.ts`) could explain what to do. The minimum is 22.13 or 23.4. The module was backported to the 22 release line before it appeared in 23, so 23.0–23.3 are newer than 22.13 but still lack the module.

The **skill distribution** is the `packages/skill/dist` directory: `SKILL.md`, `bin/sherpa.mjs`, `bin/sherpa-server.mjs`, `version.json`. The harness links to `dist`. Source files do not go into the harness.

There are 2 bundles because the agent loop invokes the CLI on every call, and a server with embedded UI would add unnecessary weight. Both use the same distribution version, the `version` field in the root `package.json`.

IBM Plex fonts are vendored. They arrive as npm packages and become part of the build (`packages/ui/src/styles/fonts.css`), so no runtime network access is needed. Restricted networks won't allow Google Fonts. Telemetry collection in these packages' `postinstall` is disabled in `pnpm-workspace.yaml`.

The UI keeps state outside the React tree, in stores with subscriptions and `useSyncExternalStore`. Patch parsing moves off the main thread into a web worker (`packages/ui/src/diff/worker.ts`). Lists use virtualization (`@tanstack/react-virtual`). The comment composer uses ProseMirror.

## 2. Data flow

The agent in the reviewer's harness receives a PR key like `<host>-<pr>` and runs `sherpa up`. The command is idempotent. It finds and reuses a live server for this PR through the manifest, or starts a daemon from the adjacent bundle that survives the CLI exiting (`packages/cli/src/up.ts`). Neither pnpm nor a repository checkout is needed. `up` prints a UI link and opens the browser on a cold start.

The PR key is optional. Without it, the CLI resolves the PR from the launch directory: Git checkout, current branch, branch PR (`packages/cli/src/pr-discovery.ts`). No step in this chain may crash the command. Any failure becomes a one-line explanation for the user.

CLI commands and their roles:

| Command | What it does |
|---|---|
| `up` | starts the PR server (or finds a live one) and prints a UI link |
| `worker register` | declares the agent session: harness, model, language used with the reviewer |
| `worker next` | long-polls for a task, returns a leased task or "No tasks" |
| `task complete` \| `progress` \| `fail` | submits a result file, sends a status line, reports a failure |

The server is one process per PR. It owns all state for that PR and all writes to its database.

**UI ↔ server: REST + SSE.** Endpoints are listed in `UI_ENDPOINTS` (`packages/protocol/src/ui.ts`). There is one event channel, `GET /api/ui/events`. Events (`state`, `review`, `progress`, `route`, `chat`) carry a revision, not data. When a tab sees the revision increase, it rereads the relevant endpoint. The token travels as a query parameter on this channel because `EventSource` does not support headers. All other endpoints use `Authorization: Bearer`.

**Session ↔ server: pull only.** The agent accepts no connections and has no address. It long-polls with `worker next`. The server leases it a task, the agent does the work and submits the result in a separate call.

A lease doesn't remove a task from the queue. A lease that expires without a response returns the task to the queue and increments its attempt count. A new session always takes precedence. Registration with a fresh `workerId` takes over the slot, and the displaced worker's leases return to the queue. Details: `docs/protocol.md §2, §5, §7`.

**Task types** are defined by `taskTypeSchema` in `packages/protocol/src/task.ts`:

- `echo`: tests the loop. The result is not parsed.
- `route.skeleton`: PR summary, stop plan, Full tour order.
- `route.section`: fills stops from the plan.
- `chat` is a reviewer question with selection context. The answer is Markdown, with no result schema.

Regeneration after a push uses the same `route.*` tasks with extra context. There is no separate type.

Each task is self-contained. A session may have died and reconnected, so the task carries all necessary context. Session memory is a bonus, not a contract.

The prompt travels as text (`instructions`). Large context travels as paths to markdown files materialized by the server (`contextFiles`). Structured tasks include a JSON schema for the result (`resultSchemaFile`). Material that stays the same between tasks (diff, files, guidance) lives at stable paths in `payload/shared`. The path lets the model recognise a file it has already read in the session. The result is submitted as a file, limited to `RESULT_MAX_BYTES` (256 KB).

Chat questions follow the same path. The endpoint queues a `chat` task with selection context, and the answer arrives through `task complete` and enters the history. The reviewer can turn an answer into a note beside a line or a comment draft.

**Generation runs in the reviewer's harness, not on the server.** The server has no model keys or model client. It prepares context, queues tasks, accepts results and validates them. The model works in the reviewer's own session, with the reviewer's access rights.

The server makes outbound requests only to the review host API and to the issue service when the reviewer sends feedback. Distribution update checks use the same review host API and only notify. Sherpa downloads and installs nothing (`packages/server/src/update-check.ts`).

The **host adapter** is the only way to access PR data. The server chooses it by the PR key prefix. Everything specific to a host lives behind this boundary (§5).

## 3. Storage in `~/.sherpa`

The state root is `~/.sherpa`, overridden by `SHERPA_DIR` in tests and development. Each side constructs paths in one place: `packages/server/src/paths.ts` and `packages/cli/src/paths.ts`.

```
~/.sherpa/
  servers/<prKey>.json     discovery manifest, 0600
  prs/<prKey>/
    sherpa.db              SQLite database for this PR
    server.log             daemon log: the server writes it, the CLI reads it if the server fails to start
    worker-id              session identity: the server writes it on registration, the CLI reads it
    payload/shared/        context shared across tasks: diff, files, guidance
    payload/route/         route generation payload, cleared for each generation
    payload/chat/          chat question payload, one directory per task
    blobs/                 cache of diff image bytes
  settings.json            global UI settings, 0600
  update-check.json        version check cache, expires after 30 minutes
```

Both sides validate the PR key with `prKeySchema` because it is used in paths. Without a restricted alphabet, it could redirect writes outside `~/.sherpa`.

The **manifest** (`serverManifestSchema`) contains `prKey`, port, PID, token, protocol and server versions, creation time. The CLI uses it to find a live server. The UI doesn't use it, since the CLI prints the link with the token. Publication is atomic. The file is prepared alongside its target and placed using `link`, the only POSIX operation that provides "create if absent" (`packages/server/src/manifest.ts`). An occupied path means a server for this PR already exists. The server removes a dead process's manifest at startup (the CLI doesn't touch manifests). Liveness checks use both the PID and a `/healthz` request with the manifest token, since any process could have taken the port.

**Permissions.** Directories under `~/.sherpa` use 0700, the manifest and `settings.json` use 0600. An explicit `chmod` sets the modes after creation, since `mkdir` and `writeFile` apply umask and directories may already exist.

The **PR database** is `sherpa.db`, using WAL. A migration list updates its schema (`packages/server/src/migrations.ts`). Migration names are permanent, and SQL for an applied migration never changes. `node:sqlite` has no nested transactions, so all server operations use the `transaction` helper with `BEGIN IMMEDIATE`. Domain errors return as values, since an exception rolls everything back.

These survive server restarts: task queue and leases, worker identity, reading progress (file and stop marks, ranges), route snapshots and generation state, iterations and computed interdiffs, chat history and agent notes, draft buffer, per-PR UI state, idle counter. Only cheap-to-recreate state lives in memory: host subscriptions, open SSE channels, the tab's parsed-patch cache.

UI settings (`diffMode`, `shipMode`, composer layout, language, onboarding and update notification state) live in one file per user, outside the PR database. Each PR server listens on a random port, and the browser's `localStorage` is empty for each new port. Disk is always the source of truth. Both reads and patch merges use fresh file contents.

## 4. Route: orchestrator and validator

Route generation has 2 phases. `route.skeleton` produces a PR summary, a stop plan with tiers, and the Full tour order. `route.section` fills planned stops with a paragraph, a transition to the next stop, diff anchors, and a digest of test assertions. State phases are `none / reading / filling / ready / failed` (`uiRoutePhaseSchema`).

A **snapshot** (`routeSnapshotSchema` in `packages/protocol/src/route.ts`) is tied to the commit and iteration it was built for: `commit`, `baseCommit`, `diffId`. Its `provenance` records the harness, model and generation language. A snapshot appears when the skeleton is accepted, grows as sections arrive, and becomes immutable in the `ready` phase. Its content hash is computed at that point. A PR has many snapshots and one current snapshot. Past snapshots remain readable.

The **validator** consists of pure modules in `packages/server/src/route/`, with no database, network or queue. It parses the result against a schema, then checks semantics.

Acceptance fails closed and runs synchronously inside the `complete` transaction. A rejected result keeps its lease and doesn't spend an attempt, so the model can fix it. The loop has a limit. After `MAX_RESULT_REJECTIONS` (3) consecutive rejections, the task fails with the last raw output.

Sections have 2 levels of reduced functionality. Soft rules remove individual elements and leave a note for the reviewer: an anchor to a missing file, an anchor outside changed lines, a range already covered by another stop, or a link to a missing thread. Hard rules reject the entire result: a plan number from another plan or a nonexistent one, `end < start`, or a stop with no surviving anchors.

The skeleton does not need the diff. Its only semantic rule is that `tourOrder` must be a permutation of the planned numbers, or the Full tour cannot be built. The server assigns stop IDs and the synthetic "Other" stop after validation. The model does not choose them.

Uncovered ranges go into a synthetic **"Other"** stop. The server adds it, the model doesn't know about it, and the UI computes its contents (uncovered ranges). With no uncovered lines, the UI hides it. When uncovered lines exceed 40 % of changed lines (`PROMOTE_THRESHOLD` in `packages/ui/src/route/route-model.ts`), it moves to the top and the UI offers to regenerate the route.

**The orchestrator's state machine uses reconciliation.** `RouteOrchestrator.reconcile` remembers no events. It reads `RouteStore` state alongside queue state and decides what to do next. Reconciliation is idempotent, so a server restart during generation, an agent dying, or a session being displaced recover without separate handling.

The server queues the first generation during warm-up (200 ms after startup, to avoid delaying the diff) if the phase is `none`, the agent is connected, and no route tasks are open. The `failed` phase requires a button click to recover, or the server would retry the same failure forever. The `filling` phase with no tasks means a server restart, not a reason to rebuild the route. Recovery of interrupted generation therefore runs before automatic queuing.

The **"small PR" threshold** is `isSmallPr` in `packages/server/src/route-orchestrator.ts`. The sum of added and deleted lines across all files must not exceed `smallPrMaxChangedLines` (40 by default, a field of `RouteConfig`). The file count does not affect the threshold. One file with 500 changed lines needs a route. A small PR is read in full. No generation is queued, and the UI opens the full diff with a notice (`uiRouteState.smallPr`).

**New iteration.** The server compares the snapshot's iteration with the host's active iteration and sends `uiRouteStale` to the UI: commits, how many iterations have appeared (a force-push counts as one), and which stops are affected, based on the interdiff between iterations.

The reviewer starts regeneration with a button. It never starts automatically. The old route remains readable until the new skeleton is accepted, and the replacement is atomic.

A regeneration task receives the previous route and discussion added since then as context (`packages/server/src/route-regeneration.ts`). If the budget is too small, stop paragraphs are cut first, starting at the end of the plan. The plan table is cut last. Truncation is marked explicitly in the text.

**Progress carryover** happens when a new snapshot is accepted, within the same transaction. Stop marks move through the interdiff line map, and the result is stored in `carried`. Stops with unchanged ranges stay marked.

The server classifies each stop against the previous snapshot deterministically: `new` if all anchor lines are affected or the file is new, `changed` if some are affected. The model does not choose this classification. It only explains it in words.

None of this is available without the host's `iterations` capability flag. Slices between iterations are rejected, and the UI only shows "route is stale".

## 5. `ReviewHost` and `HostCapabilities`

The interface is in `packages/protocol/src/review-host.ts`. Required methods fall into 4 groups:

- PR reads: `getPr`, `listIterations`, `getDiff`.
- Subscriptions: `watchIterations`, `getThreads`, `watchThreads`.
- Writes: `saveDraft`, `updateDraft`, `deleteDraft`, `setThreadResolved`, `publishBatch`.
- lenses: `ownershipLens` (CODEOWNERS, `null` when the host has no ownership concept), `extraLenses`.

Optional methods are `setFileViewed`, `getFileContent`, `getBlob`. Each has its own capability flag.

Subscriptions promise a full snapshot immediately and then on each change. The adapter chooses the transport. Polling is the common denominator across hosts, so convergence is guaranteed, immediate reactivity is not.

`getDiff` without arguments returns the active iteration. With a pair of iterations, it returns a slice between them (what changed from one to the other).

The `hostCapabilitiesSchema` (`packages/protocol/src/review.ts`) declares host capabilities with 6 flags:

| Flag | What it enables |
|---|---|
| `stickyShip` | the "Sticky ship" verdict in the publishing panel |
| `fileViewedSync` | synchronization of viewed marks with the host. Without it, `file.viewed` is always `null` and progress stays in Sherpa |
| `fileContent` | "Expand context", expanding a file beyond the patch |
| `commentIssues` | the "comment opens an issue / requires no reply" control |
| `iterations` | a list of past iterations and a slice between them. Without it, only "route is stale" is available, with no progress carryover or stop classification |
| `blobs` | an image card in the diff. Without it, a binary file stays a "binary file not shown" line |

**Invariant: a method is implemented if and only if its corresponding flag is set.** The shared `describeReviewHostContract` suite (`packages/server/src/hosts/review-host-contract.ts`) enforces this by running the same tests against every implementation. It also checks response shapes against protocol schemas, subscription promises, the two-stage draft model and consistency between `file.viewed` and `fileViewedSync`.

The **fixture host** (`packages/fixtures`) provides deterministic PRs for development, the state gallery and e2e.



Selection uses the PR key prefix in `packages/server/src/hosts/select.ts`. `fixture-<name>` selects a fixture. Any other key has no host, and review endpoints return `no_review_host`. Reading progress remains available because it is local and needs no host.

**Host specifics stay inside the adapter.** Host identifiers are opaque (`hostIdSchema`), and the contract promises only equality. Sticky ship is a verdict, not a mechanism. The few adapter-specific controls that need to leave the adapter (review status subscriptions, fixture development "push" and the write-failure switch) live in `SelectedHost` and go no further than the registration of their routes. Shared server code knows nothing about fixtures.

## 6. Non-functional requirements

**Performance.** The diff appears on screen before the route. Server startup does not wait for `getDiff`, and warmup runs on a deferred timer that does not keep the process alive.

The file tree and card list are virtualized, and a web worker parses patches. A file with more than 2000 changed lines renders collapsed (`COLLAPSE_THRESHOLD` in `packages/ui/src/diff-view/file-card.tsx`). Cards far from the viewport leave the DOM and return using hysteresis with 2 boundaries. With one boundary, they would flicker every frame when a stop's edge sat exactly on it.

The frame-time budget is a mean ≤ 16.7 ms and p95 ≤ 33 ms, measured on `fixture-huge` (100 files, about 25 thousand changed lines) in a separate run of `packages/e2e/src/performance.spec.ts`.

**Security.** Everything runs on localhost, and the server accepts no external connections. Every API endpoint, including the UI, requires a bearer token. SSE is the one exception: the token travels as a query parameter because `EventSource` doesn't support headers.

Tokens are compared by hash in constant time (`packages/server/src/auth.ts`). Comparing the strings themselves requires equal lengths and would reveal the real token's length. The UI link keeps its token in the fragment, so it never reaches the server but survives page reloads.

The manifest and settings use 0600, state directories use 0700. Outbound requests go only to the review host API and to the issue service when the reviewer explicitly sends feedback.

**Reliability.** The server survives agent termination. Leases held by a displaced or silent session return to the queue, and reconciliation repairs the generation phase. The UI survives server termination. The tab shows a banner and reconnects.

Drafts are not lost. Each save adds a record to the buffer table, and it disappears only when the host accepts it. Failure in the "server → host" step leaves the record in the buffer. Delivery retries on a timer (10 s → 30 s → 1 minute), through a button, and at the next server startup. Retries use an idempotency key to avoid creating a second comment. The buffer stores composer state, not phantom comments. Its records are not mixed into the thread snapshot.

A result over the limit fails the task with a clear error instead of failing silently. The task error appears in the UI.

**Idle shutdown.** The PR server is a background daemon, and the contract has no shutdown command. It shuts itself down after 15 minutes without open connections or requests (`DEFAULT_IDLE_SECONDS`, `packages/server/src/idle.ts`).

Each request entering the router counts as activity once. Internal timers, including SSE keepalive pings and the worker death timer, don't count. Otherwise, the server would never stop. State survives shutdown in the database, and the next `up` starts the server again.

Reviewer departure is separate from idleness. The agent receives the loop-completion signal when the last UI connection has been closed for longer than `UI_GONE_GRACE_SECONDS` (60 s). Page reloads, switching tabs, laptop sleep and brief network interruptions break SSE for seconds and do not count as departure.

**No telemetry.** Sherpa neither collects nor sends product or technical events anywhere. The only feedback channel is an issue the reviewer explicitly creates.

## 7. Invariants

**7.1. A "viewed line" derives only from manual marks.** There is no viewport tracking. A file's viewed ranges are the union of ranges in stops marked manually by the reviewer and files marked manually. They determine the 3 file states (`read` means all changed lines are covered, `partial` means some, `unread` means none). The UI uses `IntersectionObserver` only for rendering decisions: which cards to request parsing for and which to keep in the DOM. It writes no progress. Stops can be marked automatically, but this uses the same manual file marks. A stop is marked when they already cover its ranges.

**7.2. Filters hide stops with no matching files, and numbers stay as planned.** A stop with no files under the current filter disappears from view. A card held on screen remains visible. The skeleton fixes the stop number (`planIndex`), and filling does not change it. Filters and moving "Other" to the top reorder rendering, but not numbering.

**7.3. Keyboard shortcuts are declared once.** The single registry is `packages/ui/src/shortcuts/registry.ts`. Both the command palette and shortcuts sheet are built from it. The UI stores shortcuts nowhere else. There is also one `keydown` listener. It decides which scope owns a key (`global`, `route`, `full-diff`, `overview`) and handles the Esc stack. Overlay layers close in priority order, one per press.

**7.4. Reply nesting is limited by indentation.** Indentation grows up to level 4, then stops increasing. Deeper replies name the author they reply to (`packages/ui/src/threads/model.ts`).

**7.5. One server per PR, SQLite storage, task payloads in files.** One process owns each PR, and all database writes go through it, using WAL. Large task context is materialized as Markdown files, and a schema is attached only for the result. The result limit is `RESULT_MAX_BYTES` (256 KB). Larger results fail the task with a clear error. Context files are truncated to budget with an explicit truncation notice (`packages/server/src/payload-budget.ts`), so the model doesn't mistake partial context for complete context.

**7.6. The small-PR threshold is 40 changed lines.** It counts additions plus deletions across all files. File count has no effect. The threshold is a route configuration field, not a constant at the call site.

**7.7. The new session always wins.** `register` with a fresh `workerId` takes over the worker slot even from a live session. The displaced session's leases return to the queue immediately. `register` itself never returns a conflict. The displaced session learns that it lost the slot on its next call, and its pending long-poll `next` returns `worker_conflict` in the same second, without waiting out the polling window (`packages/server/src/worker-routes.ts`, `packages/server/src/worker-registry.ts`). Registration with the same `workerId` is an idempotent renewal. A call without `register` takes a free slot but does not displace a live owner. Two display rules also apply here: "Other" moves to the top when more than 40% of changed lines are uncovered (§4), and generated files start collapsed and read until the reviewer expands them by hand.
