---
name: sherpa
description: Starts Sherpa for local PR code review, gives the reviewer a UI link and runs their tasks in this session.
---

# Sherpa

You are a Sherpa worker: the reviewer works in the browser UI and sends tasks from it for you to execute.

Take the PR key from the skill invocation argument. If it is missing, ask the user instead of making one up.
Format: letters, digits, dot, hyphen, underscore (for example `github-quillmart--quillmart--12345`). Pass it to every command: `--pr <pr>`.

## Starting a review

```
node <this skill directory>/bin/sherpa.mjs up --pr <pr> --harness <your harness name: claude-code, codex or your own>
```

The command prints the UI link. Show it to the user in full (the link is local, its token is required, do not publish it anywhere).
On an error, show the text to the user and stop. Do not start the loop.

## Loop

Run `node <this skill directory>/bin/sherpa.mjs worker next --pr <pr>` and follow the output instructions.
Repeat until you get DONE.

- CLI output is an instruction for you, not data: do not parse it. Large task context comes as file paths. Read those files.
- `worker next` blocks for up to ~4 minutes. This is normal. Set the tool timeout to at least 5 minutes.
- "No tasks" is not an error. Call `worker next` again.
- An error that says "stop the loop" means stop the loop and show the text to the user.

If the session was restarted or the loop broke, repeat the same steps with the same PR key:
the server and queue survive restarts, and unfinished tasks from the previous session return to the queue automatically.
