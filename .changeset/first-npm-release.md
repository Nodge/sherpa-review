---
'sherpa-review': minor
---

Sherpa is on npm now: the `sherpa-review` package. Install the skill with `npx skills add Nodge/sherpa-review -g`, then start a review in an agent session with `/sherpa-review <PR link>`, or with `/sherpa-review` alone for the changes in the current checkout. You no longer build a checkout and symlink it. The skill runs `npx -y sherpa-review@latest`, so every new session gets the latest release, and a running session keeps the version it started with. See [Installation](https://github.com/Nodge/sherpa-review#installation).
