---
name: sherpa-review
description: "Sherpa: AI-assisted code review of pull requests and local changes. Use when the user asks to review a PR or their local changes with Sherpa."
---

# Sherpa

The instructions for this skill live in the `sherpa-review` npm package, not in this file. Run

```
npx -y sherpa-review@latest guide
```

and follow its output word for word, applying it to the argument this skill was invoked with.

- Never invent a PR key. If the argument fits none of the cases the output describes, ask the user.
- If a command fails, show its text to the user and stop. Do not guess commands.
- If your session was restarted or the loop broke off, run the command above again and continue from its output.
