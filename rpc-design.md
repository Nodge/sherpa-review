# Sherpa: RPC between the agent session and the local server

**Technical design draft v0.1 · 19.08.2026 · supplements sherpa-brief.md (section 4)**

## 1. Problem and constraints

The skill runs in the reviewer's agent harness (Claude Code, Codex and others, quite a zoo), starts a local server and opens the browser UI. The calling session stays alive as a **worker**: it executes AI tasks (route generation, chat, regeneration) queued by the UI.

The entire design follows from these constraints:

1. **The only ability a session must have is running shell commands.** Subagents, hooks and MCP aren't available in every harness.
2. **The session has no incoming interface**, so the server can't "call" it. Pull is the only model.
3. **Harness command tools have timeouts** (Claude Code: 2 min default, 10 max). The harness will kill a call that blocks forever, and the server won't know.
4. **The session can die or be interrupted** at any time. We can't interrupt it from outside either.
5. Agents tend to repeat commands and get formats wrong → idempotency and validation at the boundary are mandatory.

## 2. Topology

```
browser UI ⟷ (REST + WebSocket/SSE, bearer token) ⟷ local server ⟷ (CLI `sherpa`, pull) ⟷ agent session
                                                        │
                                                        └── disk (~/.sherpa + per-PR state): queue, snapshots, drafts, chat history
```

The 2 channels work differently:

- **UI ↔ server** uses ordinary web protocols. REST for actions, WebSocket/SSE for reactive updates: queue status, new route sections, review host comment synchronization. Nothing special.
- **Session ↔ server** pulls through the CLI. This is where the nontrivial work happens. The sections below describe it.

## 3. The `sherpa` CLI: purpose and scope

A thin client distributed with the skill. Why use it instead of plain `curl`:

- **Discovery and auth are built in**, so the agent doesn't need to know the port or token.
- **The contract is versioned** in one place instead of being spread across skill prompts.
- **Output is formatted as a prompt for the model**, not JSON to parse.

Worker commands:

| Command | Semantics |
|---|---|
| `sherpa worker next` | Long-poll: blocks until a task arrives, but returns within ≤ ~4 min ("no tasks, call again"). Every return is a heartbeat. Leases a task. |
| `sherpa task complete <id> --file <path>` | Submit a result. The server validates it on receipt and fails closed. Errors are printed as a list in prompt format: "fix these and call complete again". Repeating complete on a closed task is a no-op. |
| `sherpa task progress <id> --text "<msg>"` | A cheap status update. The UI shows "agent working: …". |
| `sherpa task fail <id> --reason "<msg>"` | Explicit failure (no access, not enough context). The task enters an error state with a reason visible in the UI. |

The skill gives the session a one-line instruction: *"Run `sherpa worker next` and follow the instructions in its output. Repeat until you get DONE."*

## 4. Task format

The `next` output is a ready-to-use prompt for the model to read:

```
TASK sherpa/42 (chat)
The reviewer asks about src/auth/session.ts:120-164 (snapshot snap-7f3a):
"why is the cache invalidated before the write here?"
Context: the diff for these lines is in /tmp/sherpa-pr123/task-42-context.md
Answer the question. Submit the result with:
  sherpa task complete 42 --file answer.md
```

Principles:

- **Large context goes in files, not stdout.** The server writes diffs/patches/schemas to temporary files and provides paths ("instruction + path to rawPatch").
- **Each task is self-contained**: the session may have died and reconnected, so the task does not rely on session memory. The payload has all the required context. Session memory is a bonus (cached understanding of the PR), not a contract.
- **The result schema is part of the task**: for structured tasks (route, section, test digest), the payload contains a JSON schema path, and the model is told that the submitted result will be validated.

Task types in v1: `route.skeleton` (section titles + intent), `route.section` (one complete section: overview, anchors, display directives, test digest), `chat` (a question with selection context), `regenerate.*` (the same after a new push, with a "what changed" diff in context).

## 5. Queue

- **Lease, not dequeue.** `next` leases a task with a TTL (10 min for interactive tasks, longer for generation). If the lease expires (the worker died silently), the task returns to the queue with an incremented attempt count. After N attempts, an error appears in the UI.
- **Two priority classes.** Interactive tasks (chat, Ask AI) always precede background tasks (route.*, digest) because the reviewer is waiting at the screen. FIFO within each class.
- **Cancellation.** The UI can cancel a task. A leased task is formally cancelled, but the session learns about it only on its next CLI call (it cannot be interrupted, limitation #4). The UI shows "agent is still busy with a cancelled task".
- **Idempotency at every endpoint**: repeated `complete`/`fail` is a no-op with a clear message. `next` with a live lease returns the same task ("you already took sherpa/42, finish it").
- **Serialization is a protocol guarantee, not a ban on parallelism** (see brief, section 4): one worker holds one lease. Within a task, the harness can use subagents in parallel.

## 6. Progressive delivery

Streaming tokens from another session through shell commands is impractical. Instead:

- **Task granularity**: a route = `route.skeleton` + one `route.section` per section. The UI becomes usable after the skeleton and fills as results arrive through complete. This is the brief's "progressive display". (A bonus: sections are independent tasks, so a harness with subagents can run them in parallel.)
- **`task progress`** provides status lines in the UI for long tasks.
- A chat answer arrives in full in one complete call.

## 7. Heartbeat and the "Agent disconnected" state

Each CLI call is a heartbeat, but liveness is not based on silence alone: a closed connection is a strong signal, silence is weak (clarified 2026-08-20, M0-T15). A worker is alive while at least one condition holds:

1. **its worker connection is open**: an idle worker hangs in long-poll `next`, and the OS immediately signals a killed session by closing its socket.
2. **it holds a task lease** and has been silent for less than M minutes (M > long-poll period, e.g. 6). During task execution the model can legitimately be silent for minutes.
3. Without a connection or lease, it has been silent for less than a short grace period (~1 min): the pause between one `next` returning and the next call.

Otherwise the server marks the worker dead → the UI switches to "Agent disconnected" (reader works, AI areas have reduced functionality, reconnect instructions shown). This directly produces the state from section 9 of the brief. Killing an idle session is visible in ~a minute. Killing during task execution takes M minutes (the server cannot distinguish "killed with a lease" from "working silently").

**Reconnect and displacement**: a new session always wins (decision 2026-08-20, amendment to spec §3.7, M0-T16). The reviewer starts the skill → the skill finds a live server through its manifest (below), does not start another → fresh session registration takes the worker slot even if the previous worker is still alive. Queue and state are on disk, so nothing is lost: unfinished leases of the displaced worker return to the queue immediately (attempt incremented, as on expiry), its pending long-polls are forcibly woken and receive `worker_conflict`, "stop the loop". No scenario requires waiting for the previous session to be declared dead.

## 8. Discovery and security

- The server uses a random localhost port. The manifest at `~/.sherpa/servers/<pr-id>.json` contains the port, PID, version and bearer token. File permissions are 0600.
- The CLI resolves the PR from cwd (or `SHERPA_PR` in env) → manifest → port+token. The agent knows neither.
- **Every channel requires a token**, including the UI (the browser gets it in the URL fragment when opened). A local API without authentication is a security hole: any process on the machine can write to the review.
- Stale manifests (dead PID) are cleaned up on the next skill launch.

## 9. Versioning

Handshake on the first `next`: the CLI sends the protocol version, and the server responds with compatibility or a human-readable "update the skill/server" error (both the model and the reviewer in the UI will see it). Skill+CLI and server are deployed independently. Version drift is inevitable in a large team, so the protocol checks it explicitly.

## 10. What has worked elsewhere

- Pull with a blocking call can keep one call alive for up to 4 days. Here it is repeated and split to fit harness timeouts.
- Fail-closed validation on submission: move `validateGuideOutput` to the RPC boundary. Also preserve raw invalid output for manual repair (here, a task error with raw output accessible from the UI).
- Lease/retry/idempotency are standard task queue semantics, nothing exotic.

## 11. Open questions

1. **CLI language, decided: a scripting runtime, not a compiled binary.** Developer machines have Node/Python, so distribution comes down to "one file in the skill package", without platform builds. The preference is **TS bundled by esbuild into one self-contained `.mjs`** (fetch is built in since Node 18): CLI and server share contract types and JSON schemas in one package, without duplicating the version handshake and validation. The fallback is Python with only stdlib, if Node availability is less certain. Hard requirements either way: one file, zero external runtime dependencies (no installs on the reviewer's machine), runtime version check at startup with a human-readable error. The loop prototype can use `curl` for the first few days, but the CLI must fix the contract before distribution to the team.
2. **One server per PR or per machine (multiplexing PRs)?** Start per-PR (simpler), the manifests already allow this. Add multiplexing if the process count becomes a problem.
3. Where to keep long-lived state: SQLite per-PR vs files. The preference is SQLite because the queue, chat history and snapshots need transactions.
4. Task context payload format: markdown files (readable for the model) vs JSON (strict). Probably markdown, with a JSON schema only for the result.
5. A size limit for `complete` results and a policy for truncating context files to fit small harness context windows.
