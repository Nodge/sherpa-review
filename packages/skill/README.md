# @sherpa/skill

The Sherpa skill package for harnesses (requirements §1/C1) is also the distribution: `SKILL.md` with session instructions
and two built bundles in `bin/`. Nothing reads the repository checkout at runtime, and pnpm is not called.

- `SKILL.md` describes what the harness does: determine the PR key (or leave it to `sherpa up`, which
  resolves the PR from the Git branch of the launch directory), run `sherpa up` (it starts the server
  and registers the session as a worker), give the reviewer the UI link and run the `sherpa worker next` loop
  (rpc-design §3, §7).
- `bin/sherpa.mjs` is the thin CLI without the server or UI: the worker loop calls it on every invocation,
  so startup must stay fast.
- `bin/sherpa-server.mjs` is the PR server with embedded UI assets. `sherpa up` starts it as a daemon from
  a sibling file (`node <bin directory>/sherpa-server.mjs`). Override the path with `SHERPA_SERVER_BIN`.

Both files are build artifacts, not stored in git.

```
pnpm --filter @sherpa/ui build
pnpm --filter @sherpa/skill build
```

The skill build builds the server bundle and CLI and puts them in `bin/`. The UI build is not part of the chain:
the server bundle embeds `packages/ui/dist` and fails with instructions if the UI has not been built.

Install in a harness by symlinking the package directory: `~/.claude/skills/sherpa` → `<repo>/packages/skill`.
You can also copy the directory anywhere. It's self-contained.
