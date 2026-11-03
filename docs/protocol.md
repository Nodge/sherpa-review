# Session↔server protocol

The session↔server protocol is how the reviewer's own agent session receives AI work from the local server and hands results back. The skill runs in the reviewer's agent harness (Claude Code, Codex and others) and starts a local server and a browser UI. The calling session then stays alive as a **worker**: it performs the AI tasks that the UI queues, such as route generation, filling stops and chat.

## 1. Problem and constraints

The server can't send a task to the session the way one web service calls another, because an agent session has no incoming interface. The one thing every harness lets a session do is run a shell command and read its output. So the session asks for work. It runs `sherpa-review worker next`, the call waits until the server has a task, and the session reads the task from stdout, does the work and submits the result with another command. The rest of the design deals with what can go wrong around that loop: a call times out, the session dies, or the agent repeats a command.

The design follows from 5 constraints:

1. **The only ability a session must have is running shell commands.** Subagents, hooks and MCP aren't available in every harness, so the protocol needs nothing beyond a shell.
2. **The session has no incoming interface.** The server can't "call" it, so pull is the only model.
3. **Command tools in harnesses have timeouts** (Claude Code: 2 minutes by default, 10 maximum). The harness kills a call that blocks forever, and nothing tells the server about it.
4. **The session can die or be interrupted at any time.** The server can't interrupt it from outside either.
5. **Agents tend to repeat commands and get formats wrong.** The protocol therefore requires idempotency and validation at the boundary. Argument parsing is forgiving for the same reason: the CLI accepts `sherpa/42` in place of `42` and tolerates quotes and backticks around labels (`parseTaskId`, `sanitizeLabel` in `packages/cli/src/args.ts`).

## 2. Topology

```
browser UI ⟷ (REST + SSE, bearer token) ⟷ local server ⟷ (CLI `sherpa-review`, pull) ⟷ agent session
                                                │
                                                └── disk (~/.sherpa + per-PR state): SQLite (queue,
                                                    snapshots, drafts, chat history) and payload files
```

The 2 channels work differently:

- **UI ↔ server** uses ordinary web protocols. REST carries actions, and SSE carries reactive updates: queue statuses, route stops appearing, review host comment synchronization. There is nothing unusual about this channel.
- **Session ↔ server** pulls through the CLI. This is where the nontrivial work happens, and the sections below describe it.

[`docs/architecture.md`](architecture.md) describes the state layout and storage.

## 3. CLI `sherpa-review`

`sherpa-review` is a thin client that ships in the npm package as one self-contained `.mjs`. The server module sits beside it, and the CLI loads that module only in `sherpa-review server`. The agent could talk to the server with plain `curl`, but the CLI gives it three things `curl` doesn't:

- **Server discovery and authorization are built in**, so the agent needs neither the port nor the token.
- **The contract is versioned in one place** instead of being spread across skill prompts.
- **Output is formatted as a prompt for the model**, not as JSON the model has to parse.

### Commands

| Command | Semantics |
|---|---|
| `sherpa-review guide` | Prints the session instructions and start commands. |
| `sherpa-review up` | Bootstraps the session: starts the review server (or finds a live one through the manifest), registers the session as a worker, and prints the UI link and the next loop step. See below for its flags and startup behaviour. |
| `sherpa-review server` | The PR server process. `up` daemonizes it, so the model doesn't need it. Arguments pass to the server module unchanged. |
| `sherpa-review worker register` | Only registers the session as a PR worker, for reconnecting to an existing server. |
| `sherpa-review worker next` | Waits indefinitely for a task and returns only with a task, `done` or an error. A returned task is leased to this worker. See below for how the wait works. |
| `sherpa-review task complete <id> --file <path>` | Submits the result. The server validates it on receipt and fails closed. Validation errors come back as a list in prompt format: "fix and call complete again". Repeating complete on a closed task is a no-op. |
| `sherpa-review task progress <id> --text "<msg>"` | Sends a lightweight status update, which the UI shows as "agent working: …". It doesn't extend the lease. |
| `sherpa-review task fail <id> --reason "<msg>"` | Declares an explicit failure (no access, insufficient context). The task enters an error state with a reason visible in the UI. |

`up` starts the server as a background daemon that survives the CLI's exit (`packages/cli/src/up.ts`). On a cold start it also opens the browser, unless `--no-open` is passed. `--local <path>` in place of `--pr` starts a working-tree review of the project directory, and `--base <ref>` sets the comparison base. `--verdicts <instruction>` replaces Comment with Ship and Request changes and passes along the user's instruction for the review outcome. A `review.feedback` task with a verdict repeats that instruction to the agent.

`worker next` loops internally over ordinary long-poll requests. The server holds each request for a window of `LONG_POLL_DEFAULT_SECONDS` = 240 s, and the request doesn't specify the window. The CLI consumes `idle` responses and immediately sends the next request, so the model sees a single call that waits. Each request is a sign of life, and while a request is pending, the open connection itself is the sign (§7).

### Flags

- `guide` takes no arguments.
- `--pr <key>` selects the PR for session commands. Without it the CLI takes `SHERPA_PR`, and without that it finds the current branch's PR through host plugins with `discoverPr`. The plugin converts a PR link or number to a key.
- `--local <path>`, `--base <ref>` and `--verdicts <instruction>` work only on `up`. `--local` conflicts with `--pr` and requires the path. `--base` and `--verdicts` require `--local`. The instruction must be nonempty and no longer than `VERDICTS_INSTRUCTION_MAX_CHARS` = 2000 characters.
- `--harness`, `--model` and `--lang <ru|en>` work on `up` and `worker register`. They are session labels for worker status and a hint for the UI language.
- `--no-open` works only on `up`.

`parseArgs` in `packages/cli/src/args.ts` holds the full parsing, and `helpText` in `format.ts` holds the help.

### What the model reads

The CLI prints instructions rather than data. A task comes in prompt format with context paths and complete submission commands (`formatTask`). `up` prints the UI link and the next step (`formatUpReady`). Server responses pass through unchanged except for the version recovery hint (§9), and at the end of the work `DONE` appears on a separate line (`formatDone`). Server errors are human-readable, and where a message doesn't make the next step clear, the CLI adds one (`NEXT_STEP_BY_CODE`).

After `up`, every command the CLI prints is self-contained: `node <absolute path to sherpa-review.mjs> <subcommand> … --pr <key>`, with the path and values quoted for a POSIX shell. The path is the running CLI file, and the key is the one the CLI connected to. Copied unchanged, such a command works from any cwd, without a checkout where the CLI could discover the PR itself. Command builders in `packages/cli/src/format.ts` assemble these commands in one place. `helpText` keeps `sherpa-review …` and placeholders.

The guide prints `up` with `npx -y sherpa-review@<version>` when running from the npx cache, which pins the session to that release. A dev build (`0.0.0`) or a build outside that cache uses `node <path>` instead.

### Exit codes

Exit code 0 covers any normal protocol exchange, including a result the validator rejected. A rejection is part of the dialogue with the model rather than a failure, and the agent reads stdout, not exit codes. Exit code 1 means the command couldn't run: invalid arguments, a discovery failure, a server RPC error or a local rejection of an oversized result.

### CLI result limit

`task complete` checks the file size before sending (`readResultFile`, `RESULT_MAX_BYTES` = 256 KB) and rejects an oversized file locally. The task stays leased, so the model has a chance to shorten the file. If the same result reached the server, the server would close the task with an error (§5).

### Session instructions

`sherpa-review guide` prints the session instructions from `packages/cli/src/guide.ts`. The skill stub in `skills/sherpa-review/SKILL.md` runs it and applies its output to the invocation argument. The guide tells the session to derive the PR key, run the printed `up` command, and show the link to the reviewer. After that the session loops over the exact `worker next` command that `up` printed and runs the commands from its output unchanged until `DONE` arrives.

The guide also defines the loop rules. The first one is that waiting costs no model turns:

- If the harness supports it, run `worker next` in the background with wake-on-completion. Otherwise run it in the foreground as one blocking call with an explicit 24-hour tool timeout, with no polling or status updates between calls.
- Restart a wait that the user interrupted.
- Stop only on `DONE` or an explicit "stop the loop".
- End every task with either `complete` or `fail --reason`.
- Read the files in `shared/` once per session, because they don't change between tasks.

## 4. Task format

The output of `next` is a ready-to-use prompt that the model reads directly. It contains a `TASK sherpa/<id> (<type>), attempt <n>` line, the instructions, a list of context files, a result schema path (if the task has one) and full submission commands (§3) of the form `node <sherpa-review.mjs> task complete <id> --file <path> --pr <key>`. In the `progress` and `fail` commands, the `--text "..."` / `--reason "..."` placeholder comes last.

The CLI chooses the result file path: `<os.tmpdir()>/sherpa-<uid>/<prKey>/<session>/<taskId>-<attempt>.json`, or `.md` for tasks without a schema. Here the session is a hash of `SHERPA_DIR` and `workerId`. The path is unique to the lease, so `complete` submits only what this attempt wrote.

### Principles

- **Large context goes in files, not stdout.** The server writes diffs, plans and chat history to Markdown files under `~/.sherpa/prs/<prKey>/payload` (directories 0700, files 0600) and gives the model absolute paths.
- **Every task is self-contained**, because the session may have died and reconnected. The task doesn't rely on session memory, and the payload holds all the context it needs. Session memory (a cached understanding of the PR) is a bonus, not part of the contract.
- **The result schema is part of the task.** A structured task includes a JSON schema path in the payload, and the task tells the model that acceptance is validated.

### Task types

`taskTypeSchema` in `packages/protocol/src/task.ts` defines the task types:

- `echo` is a dummy task for exercising the loop, and the only type the `enqueue` endpoint creates.
- `route.skeleton` produces the summary, the stop plan and the tour order.
- `route.section` fills planned stops.
- `chat` answers a reviewer question with selection context.
- `review.feedback` handles a round of published local-review comments: the agent edits code and replies in threads.

Regeneration after a new push uses the same `route.*` types with extra context, so there are no separate types for it. Validation rejects unknown types.

The payload depends on the type:

| Type | Context |
|---|---|
| `route.skeleton` | guide, PR diff, regeneration files (if any). Result schema: `routeSkeletonResult` |
| `route.section` | the same plus the plan with target stops marked. Result schema: `routeSectionResult` |
| `chat` | guide, PR diff or the file side under the anchor, question text, selection patch, route context, chat history. No result schema, the answer is Markdown |
| `review.feedback` | `feedback.md`: round verdict, project directory and every thread with absolute file path, side and line, patch fragment and conversation. Result schema: `reviewFeedbackResult` |

`generateJsonSchemas` in `packages/protocol/src/json-schema.ts` generates the result schemas from the canonical zod definitions. The task passes the schema path in `resultSchemaFile`.

### Shared and one-off context

Context that stays unchanged between tasks lives in `payload/shared` (`packages/server/src/shared-payload.ts`): the guides, and the PR diff keyed by `<base>-<head>`. One-off context lives in a directory per purpose:

- route generation: `payload/route/gen-…`. A new generation removes the previous ones.
- a chat question: `payload/chat/<uuid>`, a separate one for each question and each retry.
- a review round: `payload/feedback/<roundId>`.

The server removes directories that no live task holds, both at startup and during operation.

### Context budget

The server assembles context files within byte limits. The PR diff and the shared chat file get `CONTEXT_BUDGET_BYTES` = 320 KB (`packages/server/src/route-payload.ts`). Regeneration context gets 128 KB for the interdiff and 64 KB each for the previous route and the new threads. Chat history gets the last 8 exchanges at 8 KB each.

`fitPayloadFiles` and `fitText` in `packages/server/src/payload-budget.ts` implement the budgets. The order of files in the spec sets their priority, and the budget reserves a minimum for files not yet assembled.

The server always marks truncation in the text, so the model doesn't mistake a fragment for complete context:

- `[TRUNCATED: …]` marks removed content.
- `[UNAVAILABLE: …]` marks context that is missing entirely: a binary file or a host that didn't provide a patch.

In the PR diff, the server removes whole file patches rather than their tails. Generated files go first, then tests, then source files, and within each rank the largest go first. The PR header and the changed-file list are never truncated.

A truncated patch usually stays available in a separate file with the same gutter, in `payload/shared/diff/<key>/patches-<version>/`, and the stub left in the diff gives its path. The skeleton task opens these files only if it can't decide which stop a file belongs to. A section task reads the extracted files for its own stops and no others.

These cases get only a `patch omitted` marker, without a separate file:

- a generated file, unless it is a test
- a patch whose file is larger than the budget
- patches reduced to a marker when even the stubs exceed the budget. A stub is longer than a marker, and the reduction within a rank starts with the smallest

The shared diff filename also carries the rendering version (`pr-diff-<version>.md`). Files under a key are never overwritten, so without the version in the name a new render would pick up the old file. The UI shows what was left out separately (`UiGenerationCap`).

## 5. Queue

The queue lives in `packages/server/src/queue.ts`.

**Leases.** `next` leases a task rather than removing it from the queue. The lease TTL depends on the priority class: `LEASE_TTL_SECONDS` = 600 s for interactive tasks and 1800 s for background tasks. When a lease expires (the worker died silently), the task returns to the queue and consumes an attempt. Expiration is lazy: the queue checks leases on entry to every operation and runs no separate timer.

**Attempts.** A task gets `MAX_TASK_ATTEMPTS` = 3 attempts. Once they are exhausted, the task enters `failed` with a reason visible in the UI and never returns to the queue.

**Two priority classes.** Interactive tasks (`chat`, `review.feedback`) always go ahead of background tasks (`route.*`), because the reviewer is waiting at the screen. Within a class, the queue serves tasks FIFO by id. A task that is already leased isn't preempted.

**Cancellation.** The UI can cancel a task. A queued task closes immediately. A leased task is marked cancelled, but the worker can't be interrupted (constraint #4), so it learns about the cancellation only on its next CLI call and receives `noop` with "task cancelled, nothing to do". Until the worker responds, the UI reports that the agent is still busy with the cancelled task.

**Idempotency at every endpoint.** A repeated `complete`/`fail`/`progress` on a closed task returns `noop` with a clear message. `next` with a live lease returns the same task without a new TTL and without consuming an attempt ("finish what you started"). A caller that doesn't hold the task's lease gets `lease_not_held`.

**Fail-closed acceptance.** The acceptor for the task type (`route-orchestrator.ts`, `chat-orchestrator.ts`, `feedback-orchestrator.ts`) validates the result synchronously within the `complete` transaction. A rejection isn't an RPC error: the response is `rejected` with a list of errors, the worker keeps the lease, and no attempt is consumed. Each lease allows 3 rejections. The third one closes the task with an error, and the server saves the raw output, which is available from the UI.

The server can also answer "can't validate right now" (the diff didn't survive a restart), which is a separate outcome. The worker gets the same list with a note that no attempt was consumed, and nothing changes in storage.

**Limits.** A result larger than `RESULT_MAX_BYTES` = 256 KB closes the task with an error (`result_too_large`, HTTP 413) before validation, which is why the CLI rejects such a result in advance (§3). The request body is limited to `REQUEST_BODY_MAX_BYTES` = 1 MB (`packages/server/src/http.ts`). That limit leaves headroom above the result limit, so a moderate overrun reaches the queue and closes the task for that reason instead of being rejected as a malformed request. `progress` text is limited to `PROGRESS_TEXT_MAX_CHARS` = 500, and the schema rejects longer text.

**Sequential execution.** One worker holds one lease, so the protocol guarantees that a worker runs tasks one at a time. This doesn't ban parallelism: within a task, the harness can run subagents in parallel.

## 6. Progressive delivery

Streaming tokens from another session through shell commands is impractical, so the protocol delivers a route in pieces, one task at a time. A route is a `route.skeleton` task plus a `route.section` task per group of stops. The UI becomes usable after the skeleton and fills in as the server accepts sections. Sections are independent tasks, which is where a harness with subagents can run them in parallel.

For long tasks, `task progress` provides status lines in the UI. A chat answer arrives in full in one `complete`.

## 7. Worker liveness and reconnection

Every CLI call is a sign of life, but the server doesn't judge liveness by silence alone. A broken connection is a strong signal, and silence is a weak one. A worker is alive as long as at least one of these conditions holds (`packages/server/src/worker-registry.ts`):

1. **Its worker connection is open.** An idle worker can stay in `worker next` indefinitely, because the CLI repeats long-poll requests itself. When a session is killed, the OS closes its socket immediately, and the server sees that.
2. **It holds a task lease** and has been silent for less than `WORKER_DEAD_AFTER_SECONDS` = 360 s (and no longer than the lease itself). The model can legitimately stay silent for minutes while it executes a task.
3. **It has neither a connection nor a lease** and has been silent for less than `WORKER_GAP_GRACE_SECONDS` = 60 s. This window covers the gap between one `next` returning and the next call.

Otherwise, the server marks the worker dead, and the UI enters the "Agent disconnected" state. The reader keeps working, AI areas have reduced functionality, and the reconnection instructions are in `docs/product.md`. A killed idle session is detected within a minute. A session killed during a task is detected within 6 minutes, because the server can't distinguish "killed with a lease" from "working silently".

### Reconnection and displacement

When a new session connects, it always wins. The reviewer runs the skill, and the skill finds the live server through the manifest (§8) without starting a second one. Registration of the fresh session takes the worker slot, even if the previous worker is still alive. The queue and state are on disk, so nothing is lost.

The displaced worker loses its unfinished leases immediately: those tasks return to the queue and consume an attempt, as on expiration. Its pending long-poll requests are forced awake and receive `worker_conflict`, which means "stop the loop". Registration itself never returns `worker_conflict`, and the displaced session receives it on its subsequent calls. No scenario requires waiting until the previous session is declared dead.

### Reviewer departure

The server tracks UI presence through live SSE connections (`packages/server/src/ui-presence.ts`). Once the last one has been closed for longer than `UI_GONE_GRACE_SECONDS` = 60 s and the queue has neither waiting nor leased tasks, `next` returns `done` and the session ends. The grace period must be at least a minute, because page reloads, switching tabs, laptop sleep and network blips break SSE for seconds without meaning the reviewer has left.

`done` has no machine-readable reason field, only human-readable text. The harness behaves the same way whatever the reason.

### Server self-shutdown

The contract has no `down` command, so the server shuts itself down after idling (`packages/server/src/idle.ts`) for `DEFAULT_IDLE_SECONDS` = 15 minutes without open connections or requests. A tab's open SSE connection and a pending long-poll count as activity, and internal timers don't. SQLite state survives the shutdown, and the next `up` starts the server again. `SHERPA_IDLE_SECONDS` overrides the threshold, and 0 disables self-shutdown. The variable is undocumented and used by end-to-end tests.

## 8. Discovery and security

### Listen address and manifest

The server uses a random port and listens on `127.0.0.1` by default. `SHERPA_LISTEN_HOST=::` exposes it over IPv6 and IPv4. The manifest at `~/.sherpa/servers/<prKey>.json` stores the port, the hostname for the UI link, the PID, the token, the protocol version and the server version. Its file permissions are 0600.

The server publishes the manifest atomically, through a temporary file and `link`, so only one server can claim the path. It checks another server's liveness by calling `/healthz` with that server's token rather than by its PID, because any process could have taken the port.

The CLI finds the PR from cwd (or `SHERPA_PR` in env), the manifest from the PR, and the port and token from the manifest, so the agent knows neither. CLI host plugins with `discoverPr` find the PR from cwd, in the order listed in the composition root (`packages/cli/src/hosts/all.ts`).

### Token

**Every channel requires a token**, including the UI. A local link has the form `http://127.0.0.1:<port>/#t=<token>`, and an external listener uses the VM hostname from the manifest. The token sits in the fragment, which never reaches the server and survives page reloads. The UI also reads the old `#token=` for running servers from earlier versions (`packages/ui/src/fragment.ts`).

SSE sends the token as the query parameter `?token=`, because `EventSource` cannot set headers. This is the only exception to the bearer header, with endpoint policy `bearer-or-query`.

The token is 6 random bytes (48 bits), encoded as base64url without padding into 8 characters (`packages/server/src/auth.ts`). A 48-bit token is enough for a server that lives for hours on loopback. The token dies with the process, and the process shuts down when idle (§7). At 10⁴ attempts/s, an average brute-force search would take about 450 years, and that request rate would also put substantial load on the Node server. The margin is large enough that there is no separate attempt limiter. Token comparison uses hashes and takes constant time.

When access goes through an HTTP proxy, the SSE token from `?token=` ends up in the proxy's access logs. This is an accepted trade-off: direct HTTP access is already unencrypted, and the token lives no longer than the server. For stronger protection, use an SSH tunnel to `127.0.0.1`, which also removes the need for `SHERPA_LISTEN_HOST`.

### PR key format

The key prefix selects the host. The server takes the first plugin in the list (`packages/server/src/hosts/all.ts`) whose `keyPrefix` matches the start of the key (`docs/architecture.md §5`). Only the plugins know their prefixes, for example `github-…`, `local-<vcs>-…` and `fixture-<name>`. The shared format lives in `packages/protocol/src/pr-key.ts`: the local key skeleton `local-<vcs>-` and the GitHub key format that the CLI builds and the server parses.

A PR on github.com gets the key `github-<owner>--<repository>--<number>`. The separator is a double hyphen because owner logins cannot contain it, while repository names can. Parsing takes the owner before the first `--`, the number after the last one, and the repository between them (`packages/protocol/src/pr-key.ts`).

The CLI converts a PR link or number to a key before any checks, using the first plugin whose `normalizeKey` recognizes it. The GitHub plugin, for example, recognizes `https://github.com/<owner>/<repository>/pull/<number>` with any suffix. The normalized key then travels through the session, and `sherpa-review up` prints it. An existing key stays unchanged.

### Local review key

A local review has no key in advance, so `up --local <path>` builds one:

1. It resolves the path to an absolute one through realpath.
2. It detects the directory's VCS through host plugins with `detectLocal`: first a VCS whose marker is directly in the directory, such as its own `.git`, then the first plugin in the list that recognizes the directory.
3. It reads the directory's branch.
4. It builds the key `local-<vcs>-<directory name>-<8 hex sha256(path + branch + base from `--base`)>`.

The directory, base and branch reach the server as the `--repo`, `--base` and `--branch` arguments, and the server saves them in `~/.sherpa/prs/<key>/local-host.json` (0600). A daemon restart restores them without flags. Without either the file or the flags, there is no host.

The review verdict instruction (`--verdicts <instruction>`) travels through 2 paths. On a cold start it goes as the `--verdicts <instruction>` argument. A running server gets it as the `localVerdicts` field in the `register` request, which `up --local` always sends and `worker register` never does. A string enables verdict mode with that instruction, null disables it, and an absent field leaves the mode unchanged.

The server saves the instruction in `local-host.json` as `verdicts` (string or null), and the last `up` wins. A different instruction replaces the previous one and is saved to disk. Without the flag, the mode is disabled.

The server echoes the applied instruction as `localVerdicts` in the response. If the echo differs from `--verdicts`, the running server is older than the CLI and discarded the field. In that case `up` fails and asks for a restart, rather than promising verdicts the reviewer will never see.

### Opening the browser

On a cold start, `sherpa-review up` calls `open` / `xdg-open` / `start` directly, without a shell. The URL stays out of command history but is briefly visible in the opener process's argv. This trade-off is accepted for a local machine, because the process is short-lived and the same link is always printed to stdout. `--no-open` disables the call.

### Stale manifests

On startup, before claiming its own manifest, the server removes stale manifests that fail schema validation or belong to dead processes (`cleanStaleManifests` in `packages/server/src/manifest.ts`). The CLI leaves them alone.

## 9. Versioning

The protocol version is `PROTOCOL_VERSION` in `packages/protocol/src/version.ts`. The compatibility rule lives in the same file, in `protocolVersionsCompatible`. In the 0.x series, a minor version change is breaking, and from 1.0 on, matching major versions are enough. An unrecognized version string is incompatible.

The handshake happens on **every** worker request because the CLI keeps no state between invocations. The versions cost almost nothing in the body (the shared part of the request schemas is in `messages.ts`). A mismatch returns `version_incompatible`. The current CLI replaces the server's recovery hint with its own, using the PID from the manifest: stop the old server with `kill <pid>` or wait for it to shut down after 15 idle minutes, then run the skill again. An old server's hint may refer to an installation method that no longer applies.

This usually happens after an upgrade because `up` reuses a live server. The previous release's daemon keeps serving the PR until it stops. A response outside the contract gets a separate diagnostic without an instruction to stop the server, since it may be a failure in a server of the current version.

The distribution has its own version: the `version` field in the root `package.json`, embedded at build time. The npm distribution has no update channel because each new session runs the latest package through npx.

A build with an update channel (`UpdateChannel`) receives the latest published version in the `distributionVersionSchema` format (`packages/protocol/src/distribution.ts`) and compares it with the embedded one. If a newer version exists, the UI shows a toast with "what is new" and the channel's installation hint: an update command, or an installation directory and instruction link if the channel knows them (`uiUpdateInstallSchema`). The server downloads and installs nothing itself (`packages/server/src/update-check.ts`). It caches the check result for half an hour, and settings remember a version the reviewer dismissed.

The snapshot's `uiState.updateChannel` tells the UI whether a channel exists. Without one, the palette has no "Check for updates" command and `uiState.update` is always null. The host's `disablesUpdateCheck` flag disables only the network request and does not change that channel flag.

## 10. Endpoints

`node scripts/protocol-endpoints.mjs --write` (`pnpm docs:endpoints`) generates the table below from code. Its sources are `UI_ENDPOINTS` in `packages/protocol/src/ui.ts` and `WORKER_ENDPOINTS` in `packages/protocol/src/constants.ts`. The next run overwrites manual edits between the markers.

All endpoints require a bearer token, except SSE (§8). Review endpoints return `no_review_host` if this server's prKey maps to no host. The table excludes development endpoints (`UI_DEV_ENDPOINTS` in the same file), which exist only for fixture PRs.

Everything the UI says about a host arrives as data. `uiState.reviewHost` is the host description from its plugin (`uiReviewHostSchema`), and null means no host. Its fields:

- `id` is the adapter name, used only for state keys.
- `label` is the host label.
- `webAction` is the label of the "open file on host" action. Null falls back to the generic UI label.
- `drafts` says where drafts go: `pr` or `agent`.
- `iterations` defines an iteration: `pr` for a PR commit, `tree` for a working-tree snapshot.

The labels are `LocalizedText`, one string per UI language, because the server does not know the tab's language and grammatical cases cannot be assembled from a template. The audit scope lens (`reviewLenses`) carries `audit`: the scope name, a short chip label and a tree row tag. A regular lens has `audit: null`. The UI handles numbers and plurals ("PCI DSS · 3 files") in its own wording.

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

1. **CLI language.** The CLI runs on a script runtime rather than as a compiled binary: TypeScript bundled by esbuild into one self-contained `.mjs`. The CLI and server share contract types and schemas in one monorepo, so the handshake and validation logic are not duplicated. The requirements hold: one file, zero external runtime dependencies, and a runtime version check on startup with a plain-language error (`packages/cli/src/runtime.ts`).
2. **One server per PR or per machine.** One per PR: a manifest per `prKey`, state per `prKey`, and one worker slot per server. There is no multiplexing. Idle shutdown stops excess processes (§7).
3. **Where to keep long-lived state.** State lives in SQLite through the built-in `node:sqlite`, one database per PR. The queue, route snapshots, chat history and drafts call for transactions, and `node:sqlite` adds no external dependencies.
4. **Context payload format.** Context goes to the model as Markdown files, which it reads as text. Only results have a JSON schema, and only for structured tasks (§4).
5. **Result size and context truncation.** Results are limited to 256 KB, and the CLI rejects a larger one locally before sending. Request bodies are limited to 1 MB. The server cuts context to byte budgets with explicit truncation markers (§4, §5).
