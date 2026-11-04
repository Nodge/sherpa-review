# sherpa-review

## 0.12.1

### Patch Changes

- [#8](https://github.com/Nodge/sherpa-review/pull/8) [`d613d47`](https://github.com/Nodge/sherpa-review/commit/d613d47f56be9e78d83c4823b4af7ea981be6392) Thanks [@Nodge](https://github.com/Nodge)! - When two agent sessions start on the same pull request for the first time at once, they now always share one worker identity. Before, one session could occasionally pick up a route task that the other then failed to submit.

## 0.12.0

### Minor Changes

- [#5](https://github.com/Nodge/sherpa-review/pull/5) [`382cee5`](https://github.com/Nodge/sherpa-review/commit/382cee52b1e5861af6af78230b4cc22eed4e130f) Thanks [@Nodge](https://github.com/Nodge)! - First public release. Sherpa is a tool for AI-assisted code review in the browser: your own agent, Claude Code or Codex, reads the pull request and builds a route through it, stops ordered by importance, each with an explanation beside the diff. Install the skill with `npx skills add Nodge/sherpa-review -g`. Then call `/sherpa-review <PR link>` in an agent session, or `/sherpa-review` with no argument to review the changes in your current git checkout. The skill runs `npx -y sherpa-review@latest`, so every new session uses the latest published version and there is nothing to update by hand. See [Quick start](https://github.com/Nodge/sherpa-review#quick-start).
