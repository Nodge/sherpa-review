# @sherpa/skill

Sherpa skill package for harnesses (spec §1/C1): `SKILL.md` with session instructions and a built CLI in `bin/`.

- `SKILL.md` describes what the harness does: determine the PR key, start the server, give the reviewer the UI link,
  register as a worker and run the `sherpa worker next` loop (rpc-design §3, §7).
- `bin/sherpa.mjs` is a build artifact, a copy of `packages/cli/dist/sherpa.mjs` (not stored in git).

```
pnpm --filter @sherpa/skill build
```

The build bundles the CLI and puts it in `bin/`. In M0 the skill runs from a Sherpa repository checkout. The server
uses a native dependency (better-sqlite3) and cannot be bundled into one file, so it runs
through `pnpm --filter @sherpa/server start --pr <key>`. Distributing the server outside the repository is a task
for later stages.
