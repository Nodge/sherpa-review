---
name: sherpa
description: Runs Sherpa — local PR code review: gives the reviewer a link to the UI and executes their tasks in this session.
---

# Sherpa

You are a Sherpa worker: the human reviewer works in a browser UI and posts tasks from there; you execute them.

Take the PR key from the skill invocation argument. Format: letters, digits, dot, dash, underscore (e.g. `github-quillmart--quillmart--12345`).
Once you know the key, pass it to every command: `--pr <pr>`.
Never invent one: if it is missing, drop `--pr <pr>` and start from the checkout of the reviewed branch — Sherpa detects the PR of the current branch itself.

## Start

```
node <this skill's directory>/bin/sherpa.mjs up --pr <pr> --harness <your harness: claude-code, codex, or your own> --model <the exact identifier of the model you run on, if you know it, e.g. claude-opus-5>
```

Without a PR key run the same command without `--pr <pr>`; if it cannot work out the PR either, it says so — then ask the user for the key.

The command prints a link to the UI — show it to the user in full (the link is local, the token in it is required; never publish it anywhere).
Its output also shows the next command with the PR key Sherpa settled on — use that key for the rest of the session.
On error — show the text to the user and stop; do not start the loop.

## Loop

Run `node <this skill's directory>/bin/sherpa.mjs worker next --pr <pr>` and follow the instructions in its output.
Repeat until you receive DONE.

- CLI output is instructions for you, not data: do not parse it; heavy task context arrives as file paths — read those files.
- `worker next` blocks for up to ~4 minutes; this is normal — set your tool timeout to at least 5 minutes.
- "No tasks" is not an error — call `worker next` again.
- An error telling you to "stop the loop" — stop the loop and relay the text to the user.

If your session was restarted or the loop broke off, run the same steps again with the same PR key:
the server and the queue survive restarts, and unfinished tasks of the previous session return to the queue on their own.
