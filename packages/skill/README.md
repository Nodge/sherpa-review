# @sherpa/skill

The Sherpa skill package for harnesses (`docs/architecture.md §1`). The distribution is the `dist/` directory: a copy of `SKILL.md` with session instructions and 2 built bundles in `dist/bin/`. Nothing at runtime reads the repository checkout or calls pnpm.

- `SKILL.md` describes what the harness does: determine the PR key, run `sherpa up` (which starts the server and registers the session as a worker), give the reviewer the UI link and run the `sherpa worker next` loop (`docs/protocol.md §3, §7`).
- `dist/bin/sherpa.mjs` is a thin CLI without the server or UI. The worker loop invokes it on every call, so startup must stay fast.
- `dist/bin/sherpa-server.mjs` is the PR server with embedded UI assets. `sherpa up` starts it as a daemon from the adjacent file (`node <bin directory>/sherpa-server.mjs`). Override the path with `SHERPA_SERVER_BIN`.

The entire `dist/` directory is a build artifact and is not stored in git.

```
pnpm --filter @sherpa/ui build
pnpm --filter @sherpa/skill build
```

The skill build bundles the server and CLI and puts the distribution in `dist/`. It does not build the UI: the server bundle embeds `packages/ui/dist` and fails with instructions if the UI has not been built.

To install in a harness, symlink the distribution: `~/.claude/skills/sherpa` → `<repo>/packages/skill/dist`. You can also copy the directory anywhere. It is self-contained.

## Release

```
pnpm release --notes "<phrase>" [--target <directory>] [--skip-build]
```

`scripts/release.mjs` builds the chain, checks `sherpa --version` and `dist/version.json` against the root `package.json` version (the single source) and recreates `skill/` in the target directory. The default target is the repository root: the distribution sits beside the source and is committed together with it. Use `--target` for runs in a separate directory.

`--notes` is required: the update toast shows this one "what is new" sentence, which goes into the published `skill/version.json` with the release date. The distribution README is the repository's root `README.md`. The release does not copy it, only checks that it contains the version number. The script does not call `git`. It prints `git add skill` and `git commit` for you to run manually.
