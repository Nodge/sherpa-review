# @sherpa/skill

Sherpa skill package for harnesses (`docs/architecture.md §1`). The distribution is the `dist/` directory: a copy of `SKILL.md` with session instructions, plus the CLI and server module in `dist/bin/`. Nothing at runtime reads the repository checkout or calls pnpm.

- `SKILL.md` describes what the harness does: determine the PR key, run `sherpa-review up` (which starts the server and registers the session as a worker), give the reviewer the UI link and run the `sherpa-review worker next` loop (`docs/protocol.md §3, §7`).
- `dist/bin/sherpa-review.mjs` is the only command, a thin CLI without the server or UI. The worker loop calls it on every request, so startup must stay fast.
- `dist/bin/sherpa-review-server.mjs` is the PR server module with embedded UI assets, not an executable. Only `sherpa-review server` loads it with `import()`. This is the process `sherpa-review up` daemonizes as `node <bin directory>/sherpa-review.mjs server …`. Override the module path with `SHERPA_SERVER_BIN`.

The entire `dist/` directory is a build artifact and is not stored in git.

```
pnpm --filter @sherpa/ui build
pnpm --filter @sherpa/skill build
```

Building the skill builds the server module and CLI and assembles the distribution in `dist/`. The chain does not build the UI: the server module embeds `packages/ui/dist` and fails with instructions if the UI has not been built.

To install in a harness, symlink the distribution: `~/.claude/skills/sherpa-review` → `<repo>/packages/skill/dist`. You can also copy the directory anywhere. It is self-contained.

