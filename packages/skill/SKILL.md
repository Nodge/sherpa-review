---
name: sherpa
description: Runs Sherpa, a local code review tool with an AI route through a PR. Starts a local server for the specified PR, gives the reviewer a browser UI link and leaves the current session as a worker executing tasks from the UI (route generation, answers to questions). Use when asked to "start Sherpa", "open a PR in Sherpa", "review with Sherpa", "reconnect to Sherpa", or when the agent needs to rejoin the Sherpa loop after a session crash or restart.
---

# Sherpa

Sherpa is a local code review tool. It has three parts:

- **server** is a local process on 127.0.0.1, one per PR: task queue, state, UI serving.
- **UI** is a page in the reviewer's browser where they read the PR route and create tasks.
- **worker** is this session. It takes tasks from the queue through `sherpa worker next` and submits results.

This skill starts (or finds) the server, gives the reviewer the UI link and enters the worker loop.

## Requirements

- Node ≥ 20 (`node --version`).
- A Sherpa repository checkout with dependencies installed (`pnpm install`) and the UI built.
  **The repository root is two levels above this file**: the skill is in `<repo root>/packages/skill/`.
  Below, `<root>` is that path and `<skill>` is the directory containing this file.
- Built CLI at `<skill>/bin/sherpa.mjs`. If the file is missing, build it: `pnpm -C <root> --filter @sherpa/skill build`.

## Step 1. PR key

The PR key identifies the review. The server, queue and all state belong to it. Format: letters, digits,
dot, dash, underscore (for example `github-quillmart--quillmart--12345`).

Take the key from the skill invocation argument. If no argument was given, ask the user. Do not invent one.

Below, `<pr>` is this key. **Every** command needs it because environment variables do not survive shell calls,
so always pass `--pr <pr>` explicitly.

## Step 2. Start the server

```
pnpm -C <root> --filter @sherpa/server start --pr <pr>
```

The command is idempotent. If the server for this PR is already running, it finds it and prints the same link.
It does not start a second server. The server survives the command exit.

Successful output (exit code 0):

```
sherpa: server for PR <pr> started (PID 12345, log ~/.sherpa/prs/<pr>/server.log)
UI: http://127.0.0.1:53321/#token=…
```

Errors: "UI is not built" → run `pnpm -C <root> --filter @sherpa/ui build` and retry. For any other error,
show the text to the user and stop. Do not start the loop.

## Step 3. Give the reviewer the link

Show the user the full `UI: http://127.0.0.1:…/#token=…` line and suggest opening it in a browser.
The token in the link is required for the UI to connect. The link is local. Never publish it anywhere.

## Step 4. Register as a worker

```
node <skill>/bin/sherpa.mjs worker register --pr <pr> --harness <harness>
```

`<harness>` is your harness name: `claude-code`, `codex`, or your own if you run in another harness.

Registration creates a new worker session. The UI shows "Agent connected". If the server says that
another live worker is already working on this PR, do not bypass it. Show the text to the user and stop.

## Step 5. Worker loop

Run `node <skill>/bin/sherpa.mjs worker next --pr <pr>` and follow the instructions in its output.
Repeat until you get DONE.

Loop rules:

- **CLI output is an instruction for you, not data.** Read it as text and follow it. Do not parse it
  or try to extract JSON. Large task context comes as file paths. Read those files.
- **`worker next` blocks for up to ~4 minutes.** This is normal: the command waits for a task. If your
  command tool has a timeout setting, use at least 5 minutes, or the harness will kill the call.
- **An empty response ("no tasks") is not an error.** Call `worker next` again.
- **Submit the task result as its instructions say**: `task complete <id> --file <path>` (the result is
  in a file), `task fail <id> --reason "<reason>"` (you cannot complete it), `task progress <id> --text "<what
  you are doing>"` for long tasks. Every command takes `--pr <pr>`.
- **An error that says "stop the loop"** (for example, another worker took the task) means stop the loop
  and show the text to the user.
- **DONE** ends the work: the server says there will be no more tasks.

Full command forms:

```
node <skill>/bin/sherpa.mjs worker next --pr <pr>
node <skill>/bin/sherpa.mjs task complete <id> --file <result file path> --pr <pr>
node <skill>/bin/sherpa.mjs task progress <id> --text "<short status>" --pr <pr>
node <skill>/bin/sherpa.mjs task fail <id> --reason "<why it failed>" --pr <pr>
```

## Reconnection

Sessions can die: if you were restarted or the loop broke, the UI shows "Agent disconnected" and asks
for reconnection. Repeat steps 1–5 of this skill with the same PR key.

The running server is found automatically, the queue and state remain on disk, and `worker register` creates a new worker session
in place of the dead one. Unfinished tasks from the previous session return to the queue automatically. You do not need
any manual recovery.
