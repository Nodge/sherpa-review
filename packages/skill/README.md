# @sherpa/skill

Sherpa skill package for harnesses (product spec §1/C1). The `dist/` distribution contains a copy of `SKILL.md`
with session instructions and two built bundles in `dist/bin/`. Nothing reads
the repository checkout at runtime, and pnpm is not called.

- `SKILL.md` describes what the harness does: determine the PR key (or leave it to `sherpa up`, which
  resolves the PR from the Git branch of the launch directory), run `sherpa up` (it starts the server
  and registers the session as a worker), give the reviewer the UI link and run the `sherpa worker next` loop
  (rpc-design §3, §7).
- `dist/bin/sherpa.mjs` is a thin CLI without the server or UI. The worker loop invokes it on every call,
  so startup must stay fast.
- `dist/bin/sherpa-server.mjs` is the PR server with embedded UI assets. `sherpa up` daemonizes it as
  a sibling file (`node <bin directory>/sherpa-server.mjs`). Override the path with `SHERPA_SERVER_BIN`.

The entire `dist/` directory is a build artifact and is not stored in git.

```
pnpm --filter @sherpa/ui build
pnpm --filter @sherpa/skill build
```

The skill build bundles the server and CLI and puts the distribution in `dist/`. The UI build
runs separately. The server bundle embeds `packages/ui/dist` and fails with instructions if the UI
has not been built.

To install in a harness, symlink the distribution: `~/.claude/skills/sherpa` → `<repo>/packages/skill/dist`.
You can also copy the directory anywhere. It's self-contained.
