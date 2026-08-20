# @sherpa/skill

Sherpa skill package for harnesses (spec §1/C1): `SKILL.md` with session instructions and a built CLI in `bin/`.

- `SKILL.md` describes what the harness does: determine the PR key, run `sherpa up` (which starts the server
  and registers the session as a worker), give the reviewer the UI link and run the `sherpa worker next` loop
  (rpc-design §3, §7).
- `bin/sherpa.mjs` is a build artifact, a copy of `packages/cli/dist/sherpa.mjs` (not stored in git).

```
pnpm --filter @sherpa/skill build
```

The build bundles the CLI and puts it in `bin/`. In M0 the skill runs from a Sherpa repository checkout. The server
has a native dependency (better-sqlite3) and cannot be bundled into one file, so `sherpa up`
starts it through `pnpm --filter @sherpa/server start --pr <key>` and finds the checkout root from
its own file's real path (the skill directory can be installed as a symlink). Distributing the server outside
of the repository is left for later stages.
