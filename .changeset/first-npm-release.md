---
'sherpa-review': minor
---

First public release. Sherpa is a tool for AI-assisted code review in the browser: your own agent, Claude Code or Codex, reads the pull request and builds a route through it, stops ordered by importance, each with an explanation beside the diff. Install the skill with `npx skills add Nodge/sherpa-review -g`. Then call `/sherpa-review <PR link>` in an agent session, or `/sherpa-review` with no argument to review the changes in your current git checkout. The skill runs `npx -y sherpa-review@latest`, so every new session uses the latest published version and there is nothing to update by hand. See [Quick start](https://github.com/Nodge/sherpa-review#quick-start).
