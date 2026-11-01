# Sherpa architecture

The system's parts, how data moves between them, what is stored on disk, and the rules that hold throughout the code. Contracts live in `packages/protocol`. This document covers their meaning and boundaries. The session↔server protocol is described separately in `docs/protocol.md`.

## 1. Packages and roles

A pnpm monorepo with 7 packages, TypeScript throughout, Node ≥ 22.13.

| Package | Role |
|---|---|
| `@sherpa/protocol` | Zod schemas and types for everything that crosses boundaries: tasks and RPC messages, the review domain model, the `ReviewHost` interface, route snapshots, UI endpoints and events, the discovery manifest, limits and protocol version. No code with side effects, only schemas and pure checks |
| `@sherpa/server` | Single-PR daemon: HTTP layer, task queue with leases, host adapters, route and chat orchestrators, result validator, storage |
| `@sherpa/ui` | Reviewer's web interface: React 19, Vite build |
| `@sherpa/cli` | The single `sherpa-review` executable used by the agent. It also starts the server with `sherpa-review server` |
| `@sherpa/skill` | Harness distribution: `SKILL.md` and `bin/` with the command and server module |
| `@sherpa/fixtures` | Fixture host and deterministic data for development mode, the state gallery, e2e and performance measurements |
| `@sherpa/e2e` | End-to-end Playwright scenarios and performance measurements |

esbuild builds the **CLI** into one self-contained `.mjs` file. It has no runtime dependencies. Built-in `fetch` and the standard library are enough.

**Hosts connect through a list of plugins.** Neither the server core nor the CLI core knows hosts by name. The composition roots define which hosts a build includes: `packages/server/src/hosts/all.ts` for the server and `packages/cli/src/hosts/all.ts` for the CLI. Only entry points (`bundle.ts` and `dev.ts` for the server, `index.ts` for the CLI) and tests import the roots. From there, the list is passed as a parameter. Plugins are not loaded at runtime. Imports in one file determine the hosts at build time. The server and CLI have separate plugin contracts (§5). Only the PR key format is shared (`packages/protocol/src/pr-key.ts`).

The **server** builds the same way into one ESM module, `sherpa-review-server.mjs`, with UI assets embedded in it. Importing the module executes nothing. Its `runServer(argv)` export starts the server. `packages/server/build-server.mjs` reads `packages/ui/dist` and replaces the `src/ui-assets.ts` module with a map of "path within the build → base64 contents". This map is deliberately empty in the source. Development runs serve the UI from disk, the distribution serves it from memory, with no mode branches in the code.

Storage uses built-in `node:sqlite`. This sets the minimum Node version and lets the server build into a single file with no native dependencies.

SQLite loads on demand through `createRequire`, without a static import. Otherwise, older Node versions would crash with a raw linking error before `checkNodeVersion` (`packages/server/src/runtime.ts`) could explain what to do. The minimum is 22.13 or 23.4. The module was backported to the 22 release line before it appeared in 23, so 23.0–23.3 are newer than 22.13 but still lack the module.

The **skill distribution** is the `packages/skill/dist` directory: `SKILL.md`, `bin/sherpa-review.mjs`, `bin/sherpa-review-server.mjs`, `version.json`. The harness links to `dist`. Source files do not go into the harness.

One command, `sherpa-review`, in 2 files. Only `sherpa-review.mjs` is executable. The CLI loads the server module with `import()` at a path computed at runtime, and only in `sherpa-review server`. This keeps esbuild from pulling the server into the CLI bundle, so the agent loop, which runs the CLI for every call, does not load the server and its embedded UI. `sherpa-review up` spawns the daemon as `node <runtime flags> <sherpa-review.mjs> server …` and passes the located module in `SHERPA_SERVER_BIN`. The CLI composition root (`packages/cli/src/index.ts`) sets the daemon's runtime flags (currently `--use-system-ca`). The `up` core only filters out flags the current Node does not recognise. Both files share one distribution version, the `version` field of the root `package.json`.

IBM Plex fonts ship with the distribution. They come from npm packages and go into the build (`packages/ui/src/styles/fonts.css`), so no network is needed at runtime. A restricted network would block Google Fonts. Telemetry collection in these packages' `postinstall` is disabled in `pnpm-workspace.yaml`.

The UI keeps state outside the React tree, in stores with subscriptions and `useSyncExternalStore`. Patch parsing moves off the main thread into a web worker (`packages/ui/src/diff/worker.ts`). Lists use virtualization (`@tanstack/react-virtual`). The comment composer uses ProseMirror.

## 2. Data flow

The agent in the reviewer's harness receives a PR key in the form `<host>-<pr>` and runs `sherpa-review up`. The command is idempotent. It finds and reuses a live server for this PR through its manifest, or starts a daemon that survives the CLI's exit (`packages/cli/src/up.ts`). The daemon runs the same CLI with `sherpa-review server`, which loads the adjacent server module. Neither pnpm nor a repository checkout is needed. `up` prints a UI link and opens the browser on a cold start.

The PR key is optional. Without one, the CLI asks host plugins with `discoverPr`, in list order, which PR belongs to the current branch in the launch directory. No step in this chain may crash the command. Each failure becomes a one-line reason for the user. If discovery fails, the CLI lists every plugin's reasons and hints. A PR link or number supplied instead of a key (`--pr`, `SHERPA_PR`) is converted to a key by the first plugin whose `normalizeKey` recognises it. For example, the GitHub plugin recognises PR links on github.com.

CLI commands and their roles:

| Command | What it does |
|---|---|
| `up` | starts the PR server (or finds a live one) and prints a UI link |
| `worker register` | declares the agent session: harness, model, language used with the reviewer |
| `worker next` | waits for a task without a timeout. Returns a leased task, `done` or an error |
| `task complete` \| `progress` \| `fail` | submits a result file, sends a status line, reports a failure |

The server is one process per PR. It owns all state for that PR and all writes to its database.

**UI ↔ server: REST + SSE.** Endpoints are listed in `UI_ENDPOINTS` (`packages/protocol/src/ui.ts`). There is one event channel, `GET /api/ui/events`. Events (`state`, `review`, `progress`, `route`, `chat`) carry a revision, not data. When a tab sees the revision increase, it rereads the relevant endpoint. The token travels as a query parameter on this channel because `EventSource` does not support headers. All other endpoints use `Authorization: Bearer`.

**Session ↔ server: pull only.** The agent accepts no connections and has no address. It long-polls with `worker next`. The server leases it a task, the agent does the work and submits the result in a separate call.

A lease does not remove a task from the queue. A lease that expires silently returns the task to the queue and consumes an attempt. A new session always takes precedence. Registration with a fresh `workerId` takes over the slot, and the displaced worker's leases return to the queue. Details are in `docs/protocol.md §2, §5, §7`.

**Task types** are defined by `taskTypeSchema` in `packages/protocol/src/task.ts`:

- `echo`: tests the loop. The result is not parsed.
- `route.skeleton`: PR summary, stop plan, Full tour order.
- `route.section`: fills stops from the plan.
- `chat`: reviewer's question with selection context. The answer is markdown, with no result schema.
- `review.feedback`: a batch of published local review comments. The agent edits code in the project directory and replies in each thread.

Regeneration after a push uses the same `route.*` tasks with extra context. There is no separate type.

Each task is self-contained. A session may have died and reconnected, so the task carries all necessary context. Session memory is a bonus, not a contract.

The prompt travels as text (`instructions`). Large context travels as paths to markdown files materialized by the server (`contextFiles`). Structured tasks include a JSON schema for the result (`resultSchemaFile`). Material that stays the same between tasks (diff, files, guidance) lives at stable paths in `payload/shared`. The path lets the model recognise a file it has already read in the session. The result is submitted as a file, limited to `RESULT_MAX_BYTES` (256 KB).

Chat questions follow the same path. The endpoint queues a `chat` task with selection context, and the answer arrives through `task complete` and enters the history. The reviewer can turn an answer into a note beside a line or a comment draft.

**Generation runs in the reviewer's harness, not on the server.** The server has no model keys or model client. It prepares context, queues tasks, accepts results and validates them. The model works in the reviewer's own session, with the reviewer's access rights.

The server makes external requests only to the host API (for example, GitHub) and the feedback channel when the reviewer submits feedback. The feedback channel (`FeedbackChannel`, `packages/server/src/feedback-channel.ts`) is also a build parameter. `link` turns the Feedback button into a link to an external page. `issues` opens a form, and the channel implementation creates the issue. The server also asks the update channel whether a new distribution version is available, and only notifies the reviewer. Sherpa downloads and installs nothing (`packages/server/src/update-check.ts`). The channel (`UpdateChannel`, `packages/server/src/update-channel.ts`) is a build parameter passed by the composition root, just like the host list. The default build reads the package's `latest` tag in the npm registry (`npm-update-channel.ts`) and links feedback to the repository's GitHub issues. Without an update channel, the server does not check for updates. A host can disable network checks with `disablesUpdateCheck`. The fixture host does this, with a development endpoint supplying its version.

The **host adapter** is the only way to access PR data. The server chooses it by the PR key prefix. Everything specific to a host lives behind this boundary (§5).

## 3. Storage in `~/.sherpa`

State lives under `~/.sherpa`. Tests and development runs override it with `SHERPA_DIR`. Each side assembles paths in one place: `packages/server/src/paths.ts` and `packages/cli/src/paths.ts`.

```
~/.sherpa/
  servers/<prKey>.json     discovery manifest, 0600
  prs/<prKey>/
    sherpa.db              SQLite database for this PR
    server.log             daemon log: the server writes it, the CLI reads it if the server fails to start
    worker-id              session identity: the server writes it on registration, the CLI reads it
    local-host.json        only for local keys `local-*`: project directory, branch, base and instruction for the review outcome (`--verdicts`), 0600
    local-review.json      only for local keys `local-*`: local review comments, 0600
    local-iterations/      only for local keys `local-*`: working-tree iteration history, index and new-side blobs, 0700/0600
    payload/shared/        context shared across tasks: diff, files, guidance
    payload/route/         route generation payload, cleared for each generation
    payload/chat/          chat question payload, one directory per task
    payload/feedback/      only for local keys `local-*`: publication round payload, one directory per round
    blobs/                 cache of diff image bytes
  settings.json            global UI settings, 0600
  update-check.json        version check cache, expires after 30 minutes
```

Both sides validate the PR key with `prKeySchema` because it is used in paths. Without a restricted alphabet, it could redirect writes outside `~/.sherpa`.

The **manifest** (`serverManifestSchema`) contains `prKey`, port, PID, token, protocol and server versions, and creation time. The CLI uses it to find a live server. The UI does not use it. The CLI prints the link with the token. Publication is atomic. The server prepares a file alongside the target and puts it in place with `link`, the only POSIX operation for "create if absent" (`packages/server/src/manifest.ts`). An occupied path means a server already exists for this PR. At startup, the server removes manifests for dead processes (the CLI does not touch manifests). It checks liveness by both PID and a `/healthz` request using the manifest's token, because another process could have taken the port.

**Permissions.** Directories inside `~/.sherpa` use 0700, the manifest and `settings.json` use 0600. The server sets the modes with an explicit `chmod` after creation. `mkdir` and `writeFile` apply the umask, and directories may already exist.

The **PR database** is `sherpa.db`, with WAL enabled. A migration list maintains its schema (`packages/server/src/migrations.ts`). A migration's name is fixed forever. Never rewrite SQL in an applied migration. `node:sqlite` has no nested transactions, so all server operations use the `transaction` helper with `BEGIN IMMEDIATE`. Domain errors return as values, not exceptions, because an exception rolls back everything.

The following survive server restarts: task queue and leases, worker identity, reading progress (file and stop marks, ranges), route snapshots and generation state, iterations and computed interdiffs, chat history and agent notes, draft buffer, links between local review rounds and their tasks, per-PR UI state, and the idle counter. Memory holds only what is cheap to recreate: host subscriptions, open SSE channels, and the tab's parsed patch cache.

UI settings (`diffMode`, `shipMode`, composer layout, language, theme, text size, onboarding state and update notifications) live in one file per user, outside the PR database. Each PR server listens on a random port, and the browser's `localStorage` is empty for each new port. Disk is always the source of truth. Both reads and patch merges use the latest file contents.

The server injects the theme and text size into the served `index.html` (`packages/server/src/ui-document.ts`). The first frame must use the saved theme, while the `GET /api/ui/settings` response arrives in the second frame. An explicit theme travels as the `data-theme` attribute on `<html>`. Auto mode uses an inline script in `<head>` to set the attribute from the system theme before styles load. The UI takes over from there (`packages/ui/src/settings/document-settings.tsx`). `data-theme` always holds the resolved value. CSS knows nothing about `auto`. The UI does not overwrite attributes before `GET /api/ui/settings` responds. The first render runs on a timeout, so a slow or failed endpoint leaves the store with defaults instead of the reviewer's choice.

## 4. Route: orchestrator and validator

Route generation has 2 phases. `route.skeleton` produces a PR summary, a stop plan with tiers, and the Full tour order. `route.section` fills planned stops with a paragraph, a transition to the next stop, diff anchors, and a digest of test assertions. State phases are `none / reading / filling / ready / failed` (`uiRoutePhaseSchema`).

A **snapshot** (`routeSnapshotSchema` in `packages/protocol/src/route.ts`) is tied to the commit and iteration it was built for: `commit`, `baseCommit`, `diffId`. Its `provenance` records the harness, model and generation language. A snapshot appears when the skeleton is accepted, grows as sections arrive, and becomes immutable in the `ready` phase. Its content hash is computed at that point. A PR has many snapshots and one current snapshot. Past snapshots remain readable.

The **validator** consists of pure modules in `packages/server/src/route/`, with no database, network or queue. A schema parses the result first, then semantic checks run.

Acceptance is synchronous and fails closed, inside the `complete` transaction. A rejected result neither releases the lease nor consumes an attempt. The model corrects it itself. This loop has a limit. `MAX_RESULT_REJECTIONS` (3) consecutive rejections fail the task with the last raw output.

Sections have 2 levels of reduced functionality. Soft rules remove individual elements and leave a note for the reviewer: an anchor to a missing file, an anchor outside changed lines, a range already covered by another stop, or a link to a missing thread. Hard rules reject the entire result: a plan number from another plan or a nonexistent one, `end < start`, or a stop with no surviving anchors.

The skeleton does not need the diff. Its only semantic rule is that `tourOrder` must be a permutation of the planned numbers, or the Full tour cannot be built. The server assigns stop IDs and the synthetic "Other" stop after validation. The model does not choose them.

Uncovered ranges go into the synthetic **"Other"** stop. The server adds it without the model's involvement, and the UI computes its contents (uncovered ranges). The UI hides it while the route is incomplete or it has no uncovered lines (`otherStopVisible` in `packages/ui/src/route/other-stop.ts`). When more than 40% of changed lines are uncovered (`PROMOTE_THRESHOLD` in `packages/ui/src/route/route-model.ts`), the stop moves to the top and the UI offers to regenerate the route.

**The orchestrator's state machine uses reconciliation.** `RouteOrchestrator.reconcile` remembers no events. It reads `RouteStore` state alongside queue state and decides what to do next. Reconciliation is idempotent, so a server restart during generation, an agent dying, or a session being displaced recover without separate handling.

The server queues the first generation during warm-up (200 ms after startup, to avoid delaying the diff) if the phase is `none`, the agent is connected, and no route tasks are open. The `failed` phase requires a button click to recover, or the server would retry the same failure forever. The `filling` phase with no tasks means a server restart, not a reason to rebuild the route. Recovery of interrupted generation therefore runs before automatic queuing.

The **"small PR" threshold** is `isSmallPr` in `packages/server/src/route-orchestrator.ts`. The sum of added and deleted lines across all files must not exceed `smallPrMaxChangedLines` (40 by default, a field of `RouteConfig`). The file count does not affect the threshold. One file with 500 changed lines needs a route. A small PR is read in full. No generation is queued, and the UI opens the full diff with a notice (`uiRouteState.smallPr`).

**New iteration.** The server compares the snapshot's iteration with the host's active iteration and sends `uiRouteStale` to the UI: commits, how many iterations have appeared (a force-push counts as one), and which stops are affected, based on the interdiff between iterations.

The reviewer starts regeneration with a button. It never starts automatically. The old route remains readable until the new skeleton is accepted, and the replacement is atomic.

A regeneration task receives the previous route and discussion added since then as context (`packages/server/src/route-regeneration.ts`). If the budget is too small, stop paragraphs are cut first, starting at the end of the plan. The plan table is cut last. Truncation is marked explicitly in the text.

The server handles **progress carryover** when accepting a new snapshot, in the same transaction. Stop marks carry over through the interdiff's line map, and the result goes into `carried`. Stops with unchanged ranges stay marked.

The server classifies each stop against the previous snapshot deterministically: `new` if all anchor lines are affected or the file is new, `changed` if some are affected. The model does not choose this classification. It only explains it in words.

None of this is available without the host's `iterations` capability flag. Slices between iterations are rejected, and the UI only shows "route is stale".

## 5. `ReviewHost` and `HostCapabilities`

The interface is in `packages/protocol/src/review-host.ts`. Required methods fall into 4 groups:

- PR reads: `getPr`, `listIterations`, `getDiff`.
- Subscriptions: `watchIterations`, `getThreads`, `watchThreads`.
- Writes: `saveDraft`, `updateDraft`, `deleteDraft`, `setThreadResolved`, `publishBatch`.
- Lenses: `ownershipLens` (the host's ownership rules, such as CODEOWNERS, or the entire diff for local review. `null` means the host has no concept of ownership), `extraLenses` (for example, a PCI DSS audit scope. The UI displays a lens with an `audit` description as a header chip, a banner and a tree tag). The `ownershipSource` property names the zone source for UI labels.

Optional methods are `setFileViewed`, `getFileContent`, `getBlob`, `setCommentResolved`, `updateComment`, `deleteComment`. Each is tied to its capability flag.

Subscriptions promise a full snapshot once immediately, then on every change. The adapter chooses the transport. Polling is the common denominator across hosts, so the promise is convergence, not reactivity.

`getDiff` without arguments returns the active iteration. With a pair of iterations, it returns a slice between them (what changed from one to the other).

`hostCapabilitiesSchema` (`packages/protocol/src/review.ts`) declares host capabilities: a list of publication modes and 7 flags.

| Field | What it enables |
|---|---|
| `publishVerdicts` | publication modes the host accepts for this PR: `comment` (drafts without a verdict), `ship`, `sticky_ship`, `request_changes`. The host decides the list, including whether it contains `comment`. The publication panel renders exactly this list without distinguishing hosts. The host rejects verdicts outside the list. The list is computed on every header read because it depends on the PR, not just the host |
| `fileViewedSync` | synchronization of viewed marks with the host. Without it, `file.viewed` is always `null` and progress stays in Sherpa |
| `fileContent` | "Expand context", expanding a file beyond the patch |
| `commentIssues` | the "comment opens an issue / requires no reply" control |
| `commentResolve` | resolved state on each comment with an issue (`setCommentResolved`). The adapter computes `Thread.resolved` as "there are issues and all are resolved". Without the flag, `Comment.resolved` is always `null` |
| `editPublished` | editing and deleting your own published comments (`updateComment`, `deleteComment`) |
| `iterations` | a list of past iterations and a slice between them. Without it, only "route is stale" is available, with no progress carryover or stop classification |
| `blobs` | an image card in the diff. Without it, a binary file stays a "binary file not shown" line |

The PR header also carries the identity of its reader. `PrMeta.viewer` is this session's reviewer (`null` means the host does not know the identity). The UI uses it to distinguish the reviewer's published comments from other people's, so hosts with `editPublished` must populate it.

**Invariant: a method is implemented if and only if its corresponding flag is enabled.** The shared `describeReviewHostContract` suite (`packages/server/src/hosts/review-host-contract.ts`) enforces this by running the same tests against every implementation. All calls to the suite, including the `FixtureHost` run, live in `server` and use a relative import. The suite also checks response shapes against protocol schemas, subscription promises, the two-stage draft model, and consistency between `file.viewed` and `fileViewedSync`.

There are 3 implementations: **GitHub** (`packages/server/src/hosts/github/`), **local checkout** (`packages/server/src/hosts/local/`) and **fixture host** (`packages/fixtures`), which supplies deterministic PRs for development mode, the state gallery and e2e. The local host hides all VCS operations behind the `LocalVcs` interface (`vcs.ts`), with the `git-vcs.ts` backend. The VCS plugin (`local/git-plugin.ts`) supplies the backend on top of the shared `localHostPlugin`. `LocalHost` does not select it itself.











The **GitHub adapter** reviews PRs on github.com using the key `github-<owner>--<repository>--<number>` (a double hyphen separates parts because it cannot occur in an owner name but can in a repository name). GraphQL is the main API for metadata, threads, reviews and verdicts, viewed marks, file text, and all writes. REST remains for exactly 3 things missing from GraphQL: patch text (`…/pulls/{n}/files`), merge-base (`…/compare/{base}...{head}`), and image bytes (`…/contents/{path}`). Token lookup follows the `gh` chain: `$GITHUB_TOKEN` → `$GH_TOKEN` → `gh auth token`. No repository checkout is needed.

GitHub has one iteration. It has no diffsets, and the review compares the branch head against the merge-base, so `iterations` is disabled and slices are rejected. Of the 7 flags, `fileViewedSync`, `fileContent`, `blobs` and `editPublished` are enabled. `commentIssues` is disabled because GitHub has no such concept. `commentResolve` is disabled for the same reason. The whole thread is resolved. Publication modes on someone else's PR are `comment`, `ship` and `request_changes` (GitHub has no sticky ship). On your own PR (the PR author login matches the token owner, ignoring case), only `comment` is available. GitHub prohibits authors from both approving and requesting changes on their own PRs.

Ownership comes from CODEOWNERS on the PR's base branch. One query with 3 aliases finds the first existing file among `.github/CODEOWNERS`, `CODEOWNERS`, `docs/CODEOWNERS`. The **last** matching rule names a file's owners (other hosts may combine owners from all covering rules) and defines its zone boundary. A rule without owners clears ownership, leaving the file outside all zones. Owner teams (`@org/team`) are expanded in a separate `organization.teams(userLogins:)` query, which requires the `read:org` scope. Failure reduces functionality without causing an error. The lens is built from logins, and `note` says that team ownership was not calculated.

Drafts live in a pending GitHub review. Line comments are created directly in it. A PR draft becomes a paragraph in the review body because GitHub has nowhere else for unpublished text. Paragraphs are marked with `<!-- sherpa:draft <n> -->` (not rendered on GitHub). The marker gives each paragraph a stable ID that survives edits to neighbouring paragraphs and publication. The body is never left empty. GitHub permanently prevents edits to a review created without a body, so a pending review is created with the `<!-- sherpa:body -->` placeholder. The same placeholder replaces an empty string when the last paragraph is deleted. Publication is one `submitPullRequestReview` call, with the final body passed as a parameter (the placeholder is excluded from the published review). GitHub has no partial success. Submission either publishes all drafts with the verdict or publishes nothing. `comment` uses the `COMMENT` event and does nothing without drafts, leaving the pending review with just the placeholder. GitHub does not support idempotency keys, so the adapter keeps its own "retry key → comment" map in `~/.sherpa/prs/<key>/github-drafts.json`.

The local host reviews the working tree of a project directory in a checkout with a supported VCS against a base commit. Committed, staged, unstaged and untracked changes appear in one diff. The active iteration is the current tree state. A new one appears when the diff actually changes, and the adapter keeps previous iterations itself. Their file lists and new-side contents live in `~/.sherpa/prs/<key>/local-iterations/`, which also supplies the slice between two iterations. Of the 7 capability flags, `fileContent`, `blobs`, `iterations` and `editPublished` are enabled (your own comments can be edited and deleted directly in local storage). Without `iterations`, editing one file would clear viewed marks across the entire diff. Local review has no issues, so it cannot resolve individual comments. It resolves the whole thread. The reviewer's ownership zone is the entire diff, and its source (`ownershipSource`) is the directory's VCS diff (`git diff`). A working tree has no head commit. An iteration's `headCommit` is the same diff fingerprint as its `diffId`. Comments live beside the review state, with no remote host. By default, `comment` is the only publishing mode. There is no one to receive a verdict here, and comments are written for the agent. With `sherpa-review up --local … --verdicts '<instruction>'`, the modes match PR review: `request_changes` and `ship`, without `comment`. The agent waits for a verdict because the user has asked it to act on approval or a request for changes. The flag contains that instruction in the user's own words. The host rejects any mode outside the list. Publishing clears the draft flag and opens a round. In `comment` mode, this requires at least one published comment. A verdict opens a round even without comments, because the session must learn about it. The orchestrator (`packages/server/src/feedback-orchestrator.ts`) turns the round into a `review.feedback` task. For `comment` and `request_changes`, the agent fixes the code for each comment and replies in the threads with bot comments. Its changes create a new iteration, so the route becomes stale and the reviewer reads it again. For `ship`, the changes are approved. The agent replies in threads if there are comments, then carries out the instruction. For `ship` and `request_changes`, the task text prints the instruction verbatim in quotes. For `request_changes`, it comes after the request to fix the code based on the comments. The instruction comes from the host when the task is assembled and is not stored in the round. If the mode has been removed by then, there is no instruction. For `ship`, only the generic text remains: "if the user asked you to do something on approval, do it".

**The server host plugin** is `HostPlugin` (`packages/server/src/hosts/plugin.ts`). It contains the adapter name (also `SelectedHost.name` and `uiState.reviewHost.id`), the `ui` host description for the UI, a PR key prefix, and `make(prKey, options)`. The UI description specifies the host name, the "open on host" action label, where drafts go and what iterations mean. The server returns it in `uiState.reviewHost`, and the UI does not distinguish hosts by name. `make` returns the host for a key, or null if it cannot parse the key or start the host. The optional `unconfigured` explains in the server log why the key has no host. Plugins live beside their adapters: `github/plugin.ts` (`github-<owner>--<repository>--<number>`), `local/git-plugin.ts` (`local-git-<directory>-<hash>`) on top of the shared `local/plugin.ts`, and `fixture/plugin.ts` (`fixture-<name>`). The fixture plugin lives in the server rather than `@sherpa/fixtures`, because the server depends on fixtures and a reverse dependency would create a cycle. `startServer` receives the plugin list through `hosts`. `selectReviewHost` (`packages/server/src/hosts/select.ts`) picks the first plugin whose prefix matches the start of the key. If its `make` returns null or no prefix matches, there is no host, and review endpoints return `no_review_host`. Tests that need an already assembled host wrap it in a `hostPluginOf` plugin (`@sherpa/server/testkit`) with an empty prefix.

The local host also needs a project directory. `sherpa-review up --local <path>` supplies it (the server's `--repo` argument), and it is saved in `~/.sherpa/prs/<key>/local-host.json` so the daemon can restart without the flag. If neither is available, the local plugin explains this in the server log. Reading progress remains available because it is local and does not require a host.

**The CLI host plugin** is `CliHostPlugin` (`packages/cli/src/hosts/plugin.ts`). All capabilities are optional: `normalizeKey` converts a PR link or number into a key, `discoverPr` finds the PR for the current branch in the launch directory and explains how to enable discovery, and `detectLocal` detects a checkout of its VCS for `up --local`. It supplies the VCS type for the `local-<vcs>-…` key, plus the branch and default base as text for `up` output. Plugins are `hosts/github.ts` (a github.com PR link) and `hosts/git.ts` (a Git repository). Checkout selection for `--local` first tries the VCS whose marker is directly in the directory (`ownsDirectory`, such as a nested repository's own `.git`), then the first plugin in list order that recognizes the directory. If none recognizes it, the command fails with reasons from all of them.

**Host-specific details stay inside the adapter.** Host identifiers are opaque (`hostIdSchema`). Hosts may use signed numbers or base64-encoded protobufs, and the contract promises only equality. Sticky ship is a verdict, not a mechanism. The few adapter features that must be exposed (review-status subscriptions, forced working-tree polling and publishing rounds for the local host, a development "push" and write-failure switch for fixtures) live in `SelectedHost`. They go no further than registration of the corresponding routes. Shared server code knows nothing about fixtures.

## 6. Non-functional requirements

**Performance.** The diff appears on screen before the route. Server startup does not wait for `getDiff`, and warmup runs on a deferred timer that does not keep the process alive.

The file tree and card list are virtualized, and a web worker parses patches. A file with more than 2000 changed lines renders collapsed (`COLLAPSE_THRESHOLD` in `packages/ui/src/diff-view/file-card.tsx`). The UI removes cards far from the viewport from the DOM and restores them using hysteresis with 2 boundaries. With a single boundary, they would flicker on every frame when a stop's edge sits exactly on it.

The frame-time budget is a mean ≤ 16.7 ms and p95 ≤ 33 ms, measured on `fixture-huge` (100 files, about 25 thousand changed lines) in a separate run of `packages/e2e/src/performance.spec.ts`.

**Security.** Everything runs on localhost by default. `SHERPA_LISTEN_HOST=::` exposes the server over IPv6 and IPv4, and the UI link then uses the machine's DNS name. Every API endpoint requires a bearer token, including the UI. The only exception is SSE, where the token arrives as a query parameter because `EventSource` does not support headers. Direct HTTP access is unencrypted.

The server compares token hashes in constant time (`packages/server/src/auth.ts`). Comparing the strings themselves would require equal lengths and reveal the real token's length. The UI link carries its token in the fragment, so it never reaches the server but survives page reloads.

The manifest and settings use 0600 permissions, and state directories use 0700. The only outbound requests go to the host API and the build's feedback channel when the reviewer explicitly sends feedback.

**Reliability.** The server survives agent termination. Leases held by a displaced or silent session return to the queue, and reconciliation repairs the generation phase. The UI survives server termination. The tab shows a banner and reconnects.

Drafts are not lost. Each save adds a record to the buffer table, and it disappears only when the host accepts it. Failure in the "server → host" step leaves the record in the buffer. Delivery retries on a timer (10 s → 30 s → 1 minute), through a button, and at the next server startup. Retries use an idempotency key to avoid creating a second comment. The buffer stores composer state, not phantom comments. Its records are not mixed into the thread snapshot.

A result over the limit fails the task with a clear error instead of failing silently. The task error appears in the UI.

**Idle shutdown.** The PR server is a background daemon, and the contract has no shutdown command. It shuts itself down after 15 minutes without open connections or requests (`DEFAULT_IDLE_SECONDS`, `packages/server/src/idle.ts`).

The server tracks activity at a single router entry point. Internal timers, such as SSE keepalive pings and the worker-death timer, do not count as activity, or the server would never shut down. State survives shutdown in the database, and the next `up` starts the server again.

Reviewer departure is separate from idleness. The agent receives the loop-completion signal when the last UI connection has been closed for longer than `UI_GONE_GRACE_SECONDS` (60 s). Page reloads, switching tabs, laptop sleep and brief network interruptions break SSE for seconds and do not count as departure.

**No telemetry.** Sherpa neither collects nor sends product or technical events anywhere. The only feedback channel is an issue the reviewer explicitly creates.

## 7. Invariants

**7.1. A "viewed line" derives only from manual marks.** There is no viewport tracking. A file's viewed ranges are the union of ranges from stops the reviewer has marked by hand, either as a whole or one file card at a time, plus files marked by hand in the full diff. These produce the file's 3 states (`read` when all changed lines are covered, `partial` when some are, and `unread` when none are). The UI uses `IntersectionObserver` only for rendering decisions: which cards to send for parsing and which to keep in the DOM. It does not write progress. Stops can be marked automatically, but this uses the same manual file marks. A stop is marked when those marks already cover its ranges.

**7.2. Filters hide stops with no matching files, and numbers stay as planned.** A stop with no files under the current filter disappears from view. A card held on screen remains visible. The skeleton fixes the stop number (`planIndex`), and filling does not change it. Filters and moving "Other" to the top reorder rendering, but not numbering.

**7.3. Keyboard shortcuts are declared once.** The single registry is `packages/ui/src/shortcuts/registry.ts`. Both the Command palette and shortcuts sheet are built from it. The UI has no second place that stores shortcuts. There is also a single `keydown` listener. It decides which command owns a key by dispatching commands to scopes (`global`, `route`, `full-diff`, `overview`), and manages the Esc sequence. Overlay layers close in priority order, one per press. The key is matched against the typed character. When that is not a Latin letter or digit, the listener also checks the physical key (`event.code`) so commands work with a Russian keyboard layout.

**7.4. Reply nesting is limited by indentation.** Indentation grows up to level 4, then stops increasing. Deeper replies name the author they reply to (`packages/ui/src/threads/model.ts`).

**7.5. One server per PR, SQLite storage, task payloads as files.** One process owns each PR, and all database writes go through it, using WAL. The server materializes large task context as Markdown files and provides a schema only for the result. The result limit is `RESULT_MAX_BYTES` (256 KB). Larger results fail the task with a clear error. Context files are trimmed to fit the budget with an explicit truncation marker (`packages/server/src/payload-budget.ts`) so the model does not treat partial context as complete.

**7.6. The small-PR threshold is 40 changed lines.** It counts additions plus deletions across all files. File count has no effect. The threshold is a route configuration field, not a constant at the call site.

**7.7. The new session always wins.** `register` with a fresh `workerId` takes over the worker slot even from a live session. The displaced session's leases return to the queue immediately. `register` itself never returns a conflict. The displaced session learns that it lost the slot on its next call, and its pending long-poll `next` returns `worker_conflict` in the same second, without waiting out the polling window (`packages/server/src/worker-routes.ts`, `packages/server/src/worker-registry.ts`). Registration with the same `workerId` is an idempotent renewal. A call without `register` takes a free slot but does not displace a live owner. Two display rules also apply here: "Other" moves to the top when more than 40% of changed lines are uncovered (§4), and generated files start collapsed and read until the reviewer expands them by hand.
