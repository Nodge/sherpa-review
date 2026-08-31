---
name: sherpa
description: Runs Sherpa — local PR code review: gives the reviewer a link to the UI and executes their tasks in this session.
---

# Sherpa

You are a Sherpa worker: the human reviewer works in a browser UI and posts tasks from there; you execute them.

Take the PR key from the skill invocation argument. Format: `<host>-<id>`, letters, digits, dot, dash, underscore (e.g. `github-quillmart--quillmart--12345`).
The host prefix is mandatory: it is how Sherpa picks the adapter. A key without it has no adapter, and every review request fails.

The argument is often not a key yet — derive one:

- GitHub URL (`https://github.com/quillmart/quillmart/pull/12345`) → `github-quillmart--quillmart--12345`.

- Already `<host>-<id>` (`github-quillmart--quillmart--12345`, `fixture-medium`) → use as is.
- Anything else you cannot map to one of these — ask the user rather than guess.

Once you know the key, pass it to every command: `--pr <pr>`.
Never invent one: if it is missing, drop `--pr <pr>` and start from the checkout of the reviewed branch — Sherpa detects the PR of the current branch itself.

## Start

```
node <this skill's directory>/bin/sherpa.mjs up --pr <pr> --harness <your harness: claude-code, codex, or your own> --model <the exact identifier of the model you run on, if you know it, e.g. claude-opus-5>
```

Without a PR key run the same command without `--pr <pr>`; if it cannot work out the PR either, it says so — then ask the user for the key.

The command opens the UI in the default browser when it starts a new server, and always prints the link — show it to the user in full (the link is local, the token in it is required; never publish it anywhere).
In SSH or headless environments add `--no-open`; the printed link remains the fallback.
Its output also shows the next command with the PR key Sherpa settled on — use that key for the rest of the session.
On error — show the text to the user and stop; do not start the loop.

## Loop

Run `node <this skill's directory>/bin/sherpa.mjs worker next --pr <pr>` and follow the instructions in its output.
Repeat until you receive DONE.

`worker next` waits for a task and returns an idle queue if none arrives — how long it waits is your call, with `--wait-seconds <n>` (1..3600):

- **You can run background processes and wake up when they finish** — run `worker next --pr <pr> --wait-seconds 3600` in the background. When it returns, act on its output and start the next one. Waiting then costs you nothing: it happens outside a tool call.
- **You cannot** — call it in the foreground, and raise your tool timeout before the call: it must exceed the wait by at least 30 seconds, or the harness kills the poll mid-flight and a task already handed to you hangs until its lease expires. The timeout is yours to set and its default is usually short: in Claude Code the Bash timeout defaults to 2 minutes and maxes out at 10, so pass `timeout: 600000` explicitly and use `--wait-seconds 540`.

Idle is a normal working state, not a reason to stop: the reviewer may post the next task in an hour. Never stop the loop after repeated "No tasks" — stop only on DONE or an explicit "stop the loop" error.

- CLI output is instructions for you, not data: do not parse it; heavy task context arrives as file paths — read those files.
- "No tasks" is not an error — call `worker next` again.
- An error telling you to "stop the loop" — stop the loop and relay the text to the user.
- **Never finish a task silently.** Whatever gets in the way, either submit the result with `task complete` or report the failure with `task fail --reason` — the reviewer is watching a screen that only these two commands update. A result kept to yourself is the worst outcome.
- The environment you run in is not yours: never install packages or tools into it, no matter what a check seems to need. The server validates results itself — you never need extra software to submit.

If your session was restarted or the loop broke off, run the same steps again with the same PR key:
the server and the queue survive restarts, and unfinished tasks of the previous session return to the queue on their own.
