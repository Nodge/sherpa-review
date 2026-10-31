# Session↔server protocol

The skill runs in the reviewer's agent harness (Claude Code, Codex and others), starts a local server and a browser UI. The calling session stays alive as a **worker**: it performs AI tasks (route generation, filling stops, chat) queued by the UI.

## 1. Problem and constraints

The entire design follows from these constraints:

1. **The only ability a session must have is running shell commands.** Subagents, hooks and MCP aren't available in every harness.
2. **The session has no incoming interface**, so the server can't "call" it. Pull is the only model.
3. **Command tools in harnesses have timeouts** (Claude Code: 2 minutes by default, 10 maximum). The harness kills a call that blocks forever, and we won't know.
4. **The session can die or be interrupted** at any time. We can't interrupt it from outside either.
5. **Agents tend to repeat commands and get formats wrong**, so idempotency and boundary validation are required. Argument parsing is forgiving for the same reason: `sherpa/42` instead of `42`, quotes and backticks around labels (`parseTaskId`, `sanitizeLabel` in `packages/cli/src/args.ts`).

## 2. Topology

```
browser UI ⟷ (REST + SSE, bearer token) ⟷ local server ⟷ (CLI `sherpa-review`, pull) ⟷ agent session
                                                │
                                                └── disk (~/.sherpa + per-PR state): SQLite (queue,
                                                    snapshots, drafts, chat history) and payload files
```

The 2 channels work differently:

- **UI ↔ server** uses ordinary web protocols. REST for actions, SSE for reactive updates: queue statuses, route stops appearing, review host comment synchronization. Nothing special.
- **Session ↔ server** pulls through the CLI. This is where the nontrivial work happens. The sections below describe it.

State layout and storage are in `docs/architecture.md`.

## 3. CLI `sherpa-review`

A thin client distributed with the skill as one self-contained `.mjs`. The server module sits beside it, and the CLI loads it only in `sherpa-review server`. Why not plain `curl`:

- **Server discovery and authorization are built in**, so the agent needs neither the port nor the token.
- **The contract is versioned** in one place instead of being spread across skill prompts.
- **Output is formatted as a prompt for the model**, not JSON to parse.

| Command | Semantics |
|---|---|
| `sherpa-review up` | Bootstraps the session: starts the review server (or finds a live one through the manifest), registers as a worker, prints the UI link and the next loop step. `--local <path>` instead of `--pr` starts a working-tree review of the project directory. `--base <ref>` sets the comparison base. `--verdicts <instruction>` replaces Comment with Ship and Request changes and passes the user's instruction for the review outcome. A `review.feedback` task with a verdict repeats it to the agent. The server starts as a background daemon and survives CLI exit (`packages/cli/src/up.ts`). On a cold start it opens the browser unless `--no-open` is passed. |
| `sherpa-review server` | The PR server process. `up` daemonizes it, and the model doesn't need it. Arguments pass to the server module unchanged. |
| `sherpa-review worker register` | Only registers the session as a PR worker, for reconnecting to an existing server. |
| `sherpa-review worker next` | Waits indefinitely for a task and returns only with a task, `done` or an error. Internally it loops over ordinary long-poll requests with a server window of `LONG_POLL_DEFAULT_SECONDS` = 240 s. The CLI consumes `idle` responses and immediately sends the next request. The request doesn't specify the window. Each request is a sign of life. While it is pending, the open connection itself is the sign (§7). Leases a task. |
| `sherpa-review task complete <id> --file <path>` | Submits the result. The server validates it on receipt and fails closed. It prints validation errors as a list in prompt format: "fix and call complete again". Repeating complete on a closed task is a no-op. |
| `sherpa-review task progress <id> --text "<msg>"` | A lightweight status update. The UI shows "agent working: …". It doesn't extend the lease. |
| `sherpa-review task fail <id> --reason "<msg>"` | Explicit failure (no access, insufficient context). The task enters an error state with a reason visible in the UI. |

Flags: `--pr <key>` on every command (otherwise `SHERPA_PR`, otherwise the current branch's PR through host plugins with `discoverPr`. The plugin converts a PR link or number to a key). `--local <path>`, `--base <ref>` and `--verdicts <instruction>` only on `up` (`--local` conflicts with `--pr`, the path is required, `--base` and `--verdicts` require `--local`. The instruction must be nonempty and no longer than `VERDICTS_INSTRUCTION_MAX_CHARS` = 2000 characters). `--harness`, `--model`, `--lang <ru|en>` on `up` and `worker register` (session labels for worker status and a UI language hint). `--no-open` only on `up`. Full parsing is in `parseArgs` in `packages/cli/src/args.ts`, help in `helpText` in `format.ts`.

**What the model reads.** Output is an instruction rather than data: a task in prompt format with context paths and complete submission commands (`formatTask`), a UI link and the next step (`formatUpReady`), server responses unchanged, and `DONE` on a separate line at the end of the work (`formatDone`). Server errors are human-readable. The CLI adds the next step where the message doesn't make it clear (`NEXT_STEP_BY_CODE`).

**Printed commands are self-contained**: `node <absolute path to sherpa-review.mjs> <subcommand> … --pr <key>`, with the path and values quoted for a POSIX shell. The path is the running CLI file, and the key is the one the CLI connected to. Copied unchanged, the command works from any cwd without a checkout where the CLI can discover the PR itself. Command builders in `packages/cli/src/format.ts` assemble them in one place. `helpText` keeps `sherpa-review …` and placeholders.

**Exit codes.** 0 means any normal protocol exchange, including result rejection by the validator. This is a dialogue with the model, not a failure, and the agent reads stdout rather than exit codes. 1 means the command couldn't run: invalid arguments, discovery failure, server RPC error or local rejection of an oversized result.

**CLI result limit.** `task complete` checks the file size before sending (`readResultFile`, `RESULT_MAX_BYTES` = 256 KB) and rejects oversized files locally. The task stays leased, and the model has a chance to shorten the file. If the same result reached the server, it would close the task with an error (§5).

**Session instructions** are in `packages/skill/SKILL.md`: derive the PR key from the invocation argument, run `up` from the skill directory, show the link to the reviewer, then loop over the exact `worker next` command printed by `up` and run output commands unchanged until `DONE` arrives. The same file defines the loop rules: waiting costs no model turns. Run `worker next` in the background with wake-on-completion if the harness supports it, otherwise in the foreground as one blocking call with an explicit 24-hour tool timeout, with no polling or status updates between calls. Restart a wait interrupted by the user. Stop only on `DONE` or an explicit "stop the loop". Every task must end with either `complete` or `fail --reason`. Files in `shared/` don't change between tasks and are read once per session.

## 4. Task format

The output of `next` is a ready-to-use prompt the model reads directly: a `TASK sherpa/<id> (<type>), attempt <n>` line, instructions, a list of context files, a result schema path (if any) and full submission commands (§3): `node <sherpa-review.mjs> task complete <id> --file <path> --pr <key>`. For `progress` and `fail`, the `--text "..."` / `--reason "..."` placeholder comes last.

The CLI chooses the result file path: `<os.tmpdir()>/sherpa-<uid>/<prKey>/<session>/<taskId>-<attempt>.json` (`.md` for tasks without a schema), where the session is a hash of `SHERPA_DIR` and `workerId`. The path is unique to the lease, so `complete` submits only what this attempt wrote.

Principles:

- **Large context goes in files, not stdout.** The server writes diffs, plans and chat history to Markdown files under `~/.sherpa/prs/<prKey>/payload` (directories 0700, files 0600) and provides absolute paths.
- **Every task is self-contained**: the session may have died and reconnected. The task doesn't rely on session memory, and all required context is in the payload. Session memory is a bonus (a cached understanding of the PR), not a contract.
- **The result schema is part of the task**: structured tasks include a JSON schema path in the payload, and the model is told that acceptance is validated.

**Task types** are defined by `taskTypeSchema` in `packages/protocol/src/task.ts`: `echo` (a dummy task for exercising the loop, the only type the `enqueue` endpoint creates), `route.skeleton` (summary + stop plan + tour order), `route.section` (filling planned stops), `chat` (a reviewer question with selection context), `review.feedback` (a round of published local-review comments: the agent edits code and replies in threads). Regeneration after a new push uses the same `route.*` types with extra context. There are no separate types. Validation rejects unknown types.

**Payload by type.**

| Type | Context |
|---|---|
| `route.skeleton` | guide, PR diff, regeneration files (if any). Result schema: `routeSkeletonResult` |
| `route.section` | the same plus the plan with target stops marked. Result schema: `routeSectionResult` |
| `chat` | guide, PR diff or the file side under the anchor, question text, selection patch, route context, chat history. No result schema, the answer is Markdown |
| `review.feedback` | `feedback.md`: round verdict, project directory and every thread with absolute file path, side and line, patch fragment and conversation. Result schema: `reviewFeedbackResult` |

Schemas are generated from the canonical zod definitions (`generateJsonSchemas` in `packages/protocol/src/json-schema.ts`). The path is passed in `resultSchemaFile`.

**Shared and one-off context.** Context that stays unchanged between tasks lives in `payload/shared` (`packages/server/src/shared-payload.ts`): guides and the PR diff keyed by `<base>-<head>`. One-off context lives in the route generation directory (`payload/route/gen-…`, a new generation removes previous ones), the chat question directory (`payload/chat/<uuid>`, a separate one for each question and retry) and the review round directory (`payload/feedback/<roundId>`). The server removes directories that no live task holds, both at startup and during operation.

**Context budget.** The server assembles context files within byte limits: the PR diff and shared chat file use `CONTEXT_BUDGET_BYTES` = 320 KB (`packages/server/src/route-payload.ts`). Regeneration context gets 128 KB for the interdiff and 64 KB each for the previous route and new threads. Chat history gets the last 8 exchanges at 8 KB each. `fitPayloadFiles` and `fitText` in `packages/server/src/payload-budget.ts` implement this. Spec order sets priority, and a minimum is reserved for files not yet assembled.

Truncation is always marked in the text so the model doesn't mistake a fragment for complete context:

- `[TRUNCATED: …]` marks removed content
- `[UNAVAILABLE: …]` marks context that is missing entirely: a binary file or a host that didn't provide a patch

In the PR diff, the server removes whole file patches instead of their tails. Generated files go first, then tests, then source files. Within each rank, the largest go first. The PR header and changed-file list are never truncated.

A truncated patch usually stays available. It lives in a separate file with the same gutter in `payload/shared/diff/<key>/patches-<version>/`, and the stub in the diff gives its path. The skeleton opens these files only if it can't decide which stop a file belongs to. A section reads the extracted files for its own stops and no others. These cases get only a `patch omitted` marker, without a separate file:

- a generated file, unless it is a test
- a patch whose file is larger than the budget
- patches reduced to a marker when even the stubs exceed the budget. A stub is longer than a marker, and reduction within a rank starts with the smallest

The rendering version is also in the shared diff filename (`pr-diff-<version>.md`). Files under a key aren't overwritten, so without a version a new render would pick up the old one. The UI shows what was left out separately (`UiGenerationCap`).

## 5. Queue

Implementation: `packages/server/src/queue.ts`.

- **Lease, not dequeue.** `next` leases a task with a TTL by priority class: `LEASE_TTL_SECONDS` = 600 s for interactive tasks, 1800 s for background tasks. When a lease expires (the worker died silently), the task returns to the queue and consumes an attempt. Expiration is lazy. The queue checks leases on entry to every operation, with no separate timer.
- **Attempts.** `MAX_TASK_ATTEMPTS` = 3. Once exhausted, the task enters `failed` with a reason visible in the UI and never returns to the queue.
- **Two priority classes.** Interactive tasks (`chat`, `review.feedback`) always go ahead of background tasks (`route.*`) because the reviewer is waiting at the screen. Within a class, tasks use FIFO by id. Already leased tasks aren't preempted.
- **Cancellation.** The UI can cancel a task. A queued task closes immediately. A leased task is marked cancelled, but the worker learns this only on its next CLI call (it can't be interrupted, constraint #4), receiving `noop` with "task cancelled, nothing to do". Until the worker responds, the UI reports that the agent is still busy with the cancelled task.
- **Idempotency at every endpoint.** Repeated `complete`/`fail`/`progress` on a closed task returns `noop` with a clear message. `next` with a live lease returns the same task without a new TTL or consuming an attempt ("finish what you started"). If the caller doesn't hold the task's lease, it gets `lease_not_held`.
- **Fail-closed acceptance.** The task type's acceptor (`route-orchestrator.ts`, `chat-orchestrator.ts`, `feedback-orchestrator.ts`) validates the result synchronously within the `complete` transaction. Rejection isn't an RPC error. The response is `rejected` with a list of errors. The worker keeps the lease, and no attempt is consumed. Each lease allows 3 rejections. The third closes the task with an error, and the raw output is saved and available from the UI. A separate outcome is "the server can't validate right now" (the diff didn't survive a restart). The worker gets the same list with a note that no attempt was consumed, and nothing changes in storage.
- **Limits.** A result larger than `RESULT_MAX_BYTES` = 256 KB closes the task with an error (`result_too_large`, HTTP 413) before validation, which is why the CLI rejects it in advance (§3). The request body is limited to `REQUEST_BODY_MAX_BYTES` = 1 MB (`packages/server/src/http.ts`). This allows some headroom above the result limit so a moderate overrun reaches the queue and closes the task for that reason instead of being rejected as a malformed request. `progress` text is limited to `PROGRESS_TEXT_MAX_CHARS` = 500. The schema rejects longer text.
- **Sequential execution is a protocol guarantee, not a ban on parallelism**: one worker holds one lease. Within a task, the harness can use subagents in parallel.

## 6. Progressive delivery

Streaming tokens from another session through shell commands is impractical. Instead:

- **Task granularity**: a route is `route.skeleton` plus `route.section` per group of stops. The UI becomes usable after the skeleton and fills in as sections are accepted. This is progressive delivery. Sections are independent tasks, which is where a harness with subagents can run them in parallel.
- **`task progress`** provides status lines in the UI for long tasks.
- A chat answer arrives in full in one `complete`.

## 7. Worker liveness and reconnection

Every CLI call is a sign of life, but the server doesn't judge liveness by silence alone. A broken connection is a strong signal, silence is a weak one. A worker is alive as long as at least one condition holds (`packages/server/src/worker-registry.ts`):

1. **Its worker connection is open**. An idle worker can stay in `worker next` indefinitely (the CLI repeats long-poll requests itself), and the OS reveals a killed session by closing its socket immediately.
2. **It holds a task lease** and has been silent for less than `WORKER_DEAD_AFTER_SECONDS` = 360 s (and no longer than the lease itself). The model can legitimately stay silent for minutes while executing a task.
3. Without a connection or a lease, it has been silent for less than `WORKER_GAP_GRACE_SECONDS` = 60 s. This covers the gap between one `next` returning and the next call.

Otherwise, the server marks the worker dead → the UI enters "Agent disconnected" state (the reader works, AI areas have reduced functionality, reconnection instructions are in `docs/product.md`). A killed idle session is detected within a minute. One killed during a task is detected within 6 minutes (the server can't distinguish "killed with a lease" from "working silently").

**Reconnection and displacement**: the new session always wins. The reviewer runs the skill → the skill finds a live server through the manifest (§8), without starting a second one → registration of the fresh session takes the worker slot, even if the previous worker is still alive. The queue and state are on disk, so nothing is lost. Unfinished leases held by the displaced worker return to the queue immediately (consuming an attempt, as on expiration). Its pending long-poll requests are forced awake and receive `worker_conflict`, meaning "stop the loop". No scenario requires waiting for the previous session to be declared dead. Registration itself never returns `worker_conflict`. The displaced session receives it on subsequent calls.

**Reviewer departure.** UI presence is tracked through live SSE connections (`packages/server/src/ui-presence.ts`). Once the last one has been closed for longer than `UI_GONE_GRACE_SECONDS` = 60 s and the queue has neither waiting nor leased tasks, `next` returns `done` and the session ends. The grace period must be at least a minute. Page reloads, switching tabs, laptop sleep and network blips break SSE for seconds without meaning the reviewer has left. `done` has no machine-readable reason field, only human-readable text. The harness behaves the same way for every reason.

**Server self-shutdown.** The contract has no `down` command, so the server shuts itself down after idling (`packages/server/src/idle.ts`): `DEFAULT_IDLE_SECONDS` = 15 minutes without open connections or requests. A tab's open SSE connection and a pending long-poll count as activity. Internal timers don't. SQLite state survives shutdown, and the next `up` starts the server again. `SHERPA_IDLE_SECONDS` overrides the threshold (0 disables self-shutdown). It is undocumented and used by end-to-end tests.

## 8. Discovery and security

- The server uses a random port and listens on `127.0.0.1` by default. `SHERPA_LISTEN_HOST=::` exposes it over IPv6 and IPv4. The manifest at `~/.sherpa/servers/<prKey>.json` stores the port, hostname for the UI link, PID, token, protocol version and server version. File permissions are 0600. The token is 6 random bytes (48 bits), encoded as base64url without padding, 8 characters (`packages/server/src/auth.ts`).
- The server publishes the manifest atomically using a temporary file and `link`. Only one server can claim the path. It checks another server's liveness through `/healthz` with that server's token, rather than its PID, because any process could have taken the port.
- The CLI finds the PR from cwd (or `SHERPA_PR` in env) → manifest → port and token. The agent knows neither. CLI host plugins with `discoverPr` find the PR from cwd, in the order listed in the composition root (`packages/cli/src/hosts/all.ts`).
- The key prefix selects the host. The server takes the first plugin in the list (`packages/server/src/hosts/all.ts`) whose `keyPrefix` matches the start of the key (`docs/architecture.md §5`). Only the plugins know their prefixes. Examples: `github-…`, `local-<vcs>-…`, `fixture-<name>`. The shared format lives in `packages/protocol/src/pr-key.ts`: the local key skeleton `local-<vcs>-` and the GitHub key format that the CLI builds and the server parses.
- **Every channel requires a token**, including the UI. A local link has the form `http://127.0.0.1:<port>/#t=<token>`. An external listener uses the VM hostname from the manifest. The fragment never reaches the server and survives page reloads. The UI also reads the old `#token=` for running servers from earlier versions (`packages/ui/src/fragment.ts`). SSE sends the token as the query parameter `?token=` because `EventSource` cannot set headers. This is the only exception, with endpoint policy `bearer-or-query`.
- 48 bits is enough for a server that lives for hours. The token dies with the process, and the process shuts down when idle (§7). At 10⁴ attempts/s, an average brute-force search would take about 450 years. That request rate would also put substantial load on the Node server, so there is still no separate attempt limiter. Token comparison uses hashes and takes constant time.
- Accepted trade-off: when access goes through an HTTP proxy, the SSE token from `?token=` ends up in its access logs. Direct HTTP access is already unencrypted, and the token lives no longer than the server. For stronger protection, use an SSH tunnel to `127.0.0.1`, which also removes the need for `SHERPA_LISTEN_HOST`.
- A PR on github.com gets the key `github-<owner>--<repository>--<number>`. The separator is a double hyphen because owner logins cannot contain it, while repository names can. Parsing takes the owner before the first `--`, the number after the last, and the repository between them (`packages/protocol/src/pr-key.ts`). The CLI converts a PR link or number to a key before any checks, using the first plugin whose `normalizeKey` recognizes it. For example, the GitHub plugin recognizes `https://github.com/<owner>/<repository>/pull/<number>` with any suffix. The normalized key then travels through the session and is printed by `sherpa-review up`. An existing key stays unchanged.
- A local review has no key in advance. `up --local <path>` resolves the path to an absolute one through realpath, detects the directory's VCS through host plugins with `detectLocal` (first a VCS whose marker is directly in the directory, such as its own `.git`, then the first plugin in the list that recognizes the directory), reads its branch and builds the key `local-<vcs>-<directory name>-<8 hex sha256(path + branch + base from `--base`)>`. The directory, base and branch reach the server as `--repo`, `--base` and `--branch` arguments and are saved in `~/.sherpa/prs/<key>/local-host.json` (0600). A daemon restart restores them without flags. Without either the file or the flags, there is no host. The review verdict instruction (`--verdicts <instruction>`) travels through 2 paths: on a cold start, as the `--verdicts <instruction>` argument, and to a running server, as the `localVerdicts` field in the `register` request, which `up --local` always sends (`worker register` never does). A string enables verdict mode with that instruction, null disables it, and an absent field leaves the mode unchanged. The instruction is saved in `local-host.json` as `verdicts` (string or null). The last `up` wins. A different instruction replaces the previous one and is saved to disk. Without the flag, the mode is disabled. The server echoes the applied instruction as `localVerdicts` in the response. If the echo differs from `--verdicts`, the running server is older than the CLI and discarded the field. `up` fails and asks for a restart, rather than promising verdicts the reviewer will never see.
- **Every channel requires a token**, including the UI. The link has the form `http://127.0.0.1:<port>/#t=<token>`. The fragment never reaches the server and survives page reloads. The UI also reads the old `#token=` for running servers from earlier versions (`packages/ui/src/fragment.ts`). SSE sends the token as the query parameter `?token=` because `EventSource` cannot set headers. This is the only exception, with endpoint policy `bearer-or-query`.
- 48 bits is enough for a server that lives for hours on loopback. At 10⁴ attempts/s, an average brute-force search would take about 450 years. That margin is enough, so there is no separate attempt limiter. Token comparison uses hashes and takes constant time.
- On a cold start, `sherpa-review up` calls `open` / `xdg-open` / `start` directly, without a shell. The URL stays out of command history but is briefly visible in the opener process's argv. This trade-off is accepted for a local machine. The process is short-lived, and the same link is always printed to stdout. `--no-open` disables the call.
- On startup, before claiming its own manifest, the server removes stale manifests that fail schema validation or belong to dead processes (`cleanStaleManifests` in `packages/server/src/manifest.ts`). The CLI leaves them alone.

## 9. Versioning

The protocol version is `PROTOCOL_VERSION` in `packages/protocol/src/version.ts`. The compatibility rule lives there too, in `protocolVersionsCompatible`: in the 0.x series, a minor version change is breaking. From 1.0, matching major versions are enough. An unrecognized version string is incompatible.

The handshake happens on **every** worker request, not just the first. The CLI keeps no state between invocations, and versions cost almost nothing in the body (the shared part of the request schemas is in `messages.ts`). Incompatibility returns `version_incompatible` with the plain-language message "update the skill and CLI together and restart the server, they ship together". Both the model in its output and the reviewer in the UI see it. The skill with its CLI and the server deploy independently. Version drift is inevitable in a large team, so it gets an explicit check.

The skill distribution has its own version: `version.json` at the skill directory root, next to `bin/` (`distributionVersionSchema` in `packages/protocol/src/distribution.ts`). The server receives the latest published version in the same format from the update channel it was built with (`UpdateChannel`, such as the npm registry or `version.json` in the source repository). It compares that version with the embedded one. If a newer version exists, the UI shows a toast with "what is new" and the channel's installation hint: an update command, or an installation directory and instruction link if the channel knows them (`uiUpdateInstallSchema`). The server downloads and installs nothing itself (`packages/server/src/update-check.ts`). The check result is cached for half an hour. A version dismissed by the reviewer is remembered in settings.

## 10. Endpoints

The table is generated from code with `node scripts/protocol-endpoints.mjs --write` (`pnpm docs:endpoints`). Sources: `UI_ENDPOINTS` in `packages/protocol/src/ui.ts` and `WORKER_ENDPOINTS` in `packages/protocol/src/constants.ts`. The next run overwrites manual edits between the markers.

All endpoints require a bearer token, except SSE (§8). Review endpoints return `no_review_host` if this server's prKey maps to no host. The table excludes development endpoints (`UI_DEV_ENDPOINTS` in the same file), which exist only for fixture PRs.

Everything the UI says about a host arrives as data. `uiState.reviewHost` is the host description from its plugin (`uiReviewHostSchema`): adapter name `id` is used only for state keys, `label` is the host label, `webAction` is the "open file on host" action label (null uses the generic UI label), `drafts` says where drafts go (`pr` or `agent`), and `iterations` defines an iteration (`pr` for a PR commit, `tree` for a working-tree snapshot). Null means no host. Labels are `LocalizedText`, one string per UI language. The server does not know the tab's language, and grammatical cases cannot be assembled from a template. The audit scope lens (`reviewLenses`) carries `audit`: scope name, short chip label and tree row tag. A regular lens has `audit: null`. The UI handles numbers and plurals ("PCI DSS · 3 files") in its own wording.

<!-- endpoints:start -->
### UI endpoints

| Key | Method and path | Purpose |
|---|---|---|
| `state` | `GET /api/ui/state` | PR state snapshot for the first render |
| `enqueue` | `POST /api/ui/tasks` | enqueue a task from the UI (`echo` only, development demo of the loop) |
| `cancel` | `POST /api/ui/tasks/cancel` | cancel an enqueued task |
| `events` | `GET /api/ui/events` | SSE stream: state snapshot and revisions for review, progress, route and chat |
| `reviewDiff` | `GET /api/ui/review/diff` | PR iteration diff |
| `reviewThreads` | `GET /api/ui/review/threads` | PR comment threads |
| `reviewLenses` | `GET /api/ui/review/lenses` | file filter lenses |
| `reviewFileContent` | `GET /api/ui/review/file-content` | file content for context expansion |
| `reviewBlob` | `GET /api/ui/review/blob` | image bytes by `blobId` |
| `reviewProgress` | `GET /api/ui/review/progress` | reading progress for an iteration |
| `reviewFileViewed` | `POST /api/ui/review/file-viewed` | mark a file as read |
| `reviewStopViewed` | `POST /api/ui/review/stop-viewed` | mark a stop's ranges as read |
| `reviewStopFileViewed` | `POST /api/ui/review/stop-file-viewed` | mark a file's lines as read within one stop |
| `reviewViewedMirror` | `POST /api/ui/review/viewed-mirror` | mirror the "file read" mark to the host |
| `reviewSaveDraft` | `POST /api/ui/review/draft` | save a comment draft |
| `reviewUpdateDraft` | `POST /api/ui/review/draft/update` | edit a comment draft |
| `reviewDraftBuffer` | `GET /api/ui/review/draft-buffer` | buffer of drafts the host did not accept |
| `reviewDraftBufferRetry` | `POST /api/ui/review/draft-buffer/retry` | retry saving a buffered draft |
| `reviewDraftBufferDiscard` | `POST /api/ui/review/draft-buffer/discard` | discard a buffered draft |
| `reviewDeleteDraft` | `POST /api/ui/review/draft/delete` | delete a comment draft |
| `reviewThreadResolved` | `POST /api/ui/review/thread-resolved` | mark a thread as resolved |
| `reviewCommentResolved` | `POST /api/ui/review/comment-resolved` | mark an issue comment as resolved |
| `reviewUpdateComment` | `POST /api/ui/review/comment/update` | edit your published comment |
| `reviewDeleteComment` | `POST /api/ui/review/comment/delete` | delete your published comment |
| `reviewPublish` | `POST /api/ui/review/publish` | publish drafts with a verdict |
| `reviewRoute` | `GET /api/ui/review/route` | snapshot route |
| `reviewSnapshots` | `GET /api/ui/review/snapshots` | list route snapshots |
| `reviewRouteGenerate` | `POST /api/ui/review/route/generate` | start or restart route generation |
| `reviewRouteFillStop` | `POST /api/ui/review/route/fill-stop` | refill one stop |
| `reviewChat` | `GET /api/ui/review/chat` | chat history and agent notes |
| `reviewChatAsk` | `POST /api/ui/review/chat/ask` | ask the agent a question |
| `reviewChatCancel` | `POST /api/ui/review/chat/cancel` | cancel a submitted question |
| `reviewChatRetry` | `POST /api/ui/review/chat/retry` | retry a failed question |
| `reviewChatNoteDelete` | `POST /api/ui/review/chat/note-delete` | delete an agent note |
| `feedback` | `POST /api/ui/feedback` | reviewer feedback to the build's feedback channel |
| `updateCheck` | `POST /api/ui/update-check` | check for a new distribution version on demand |
| `settings` | `GET, PATCH /api/ui/settings` | read and update reviewer settings |
| `prState` | `GET, PATCH /api/ui/pr-state` | this PR's UI state: collapsed nodes and recent palette commands |

### Worker endpoints

| Key | Method and path | Purpose |
|---|---|---|
| `register` | `POST /api/worker/register` | register the PR worker session |
| `next` | `POST /api/worker/next` | long-poll for the next task |
| `complete` | `POST /api/task/complete` | submit a task result |
| `progress` | `POST /api/task/progress` | report task status |
| `fail` | `POST /api/task/fail` | decline a task with a reason |
<!-- endpoints:end -->

## 11. Resolved questions

1. **CLI language.** A script runtime, not a compiled binary: TS bundled by esbuild into one self-contained `.mjs`. The CLI and server share contract types and schemas in one monorepo, so handshake and validation logic are not duplicated. The requirements hold: one file, zero external runtime dependencies, a runtime version check on startup with a plain-language error (`packages/cli/src/runtime.ts`).
2. **One server per PR or per machine.** Per PR: manifest per `prKey`, state per `prKey`, one worker slot per server. There is no multiplexing. Idle shutdown stops excess processes (§7).
3. **Where to keep long-lived state.** SQLite through the built-in `node:sqlite`, one database per PR. The queue, route snapshots, chat history and drafts call for transactions, and this adds no external dependencies.
4. **Context payload format.** Markdown files, which the model reads as text. Only results have a JSON schema, and only for structured tasks (§4).
5. **Result size and context truncation.** Results are limited to 256 KB, rejected locally by the CLI before sending. Request bodies are limited to 1 MB. Context is cut to byte budgets with explicit truncation markers (§4, §5).
