# @sherpa/npm

This package builds the published `sherpa-review` npm package into `dist/`. The result contains `package.json`, `README.md`, `LICENSE`, `THIRD-PARTY-LICENSES.txt` and 2 files in `bin/`. Nothing at runtime reads the repository checkout or calls pnpm. See [`docs/architecture.md`](../../docs/architecture.md) §1 for the build design.

## Build

Build the UI first, then the npm package:

```
pnpm --filter @sherpa/ui build
pnpm --filter @sherpa/npm build
```

The npm build assembles the CLI and server module. It does not build the UI, because the server embeds the existing `packages/ui/dist`. A missing UI build produces an error with instructions.

## Contents

- `dist/bin/sherpa-review.mjs` is the only executable. The worker loop runs this thin CLI on every request, so it contains neither the server nor the UI. Its `guide` command prints the session instructions that the skill stub in `skills/sherpa-review/SKILL.md` asks the agent to follow.
- `dist/bin/sherpa-review-server.mjs` is the PR server module with embedded UI assets. Only `sherpa-review server` loads it with `import()`. The `up` command starts the daemon as `node <bin directory>/sherpa-review.mjs server …`. `SHERPA_SERVER_BIN` overrides the module path.

`build.mjs` generates the manifest with the version from the root `package.json`, no dependencies and no scripts. The entire `dist/` directory is a build artifact and is not stored in git.

## Bundled licenses

`THIRD-PARTY-LICENSES.txt` lists the packages whose code or assets, including fonts, reach the bundles. It uses the CLI and server esbuild metafiles and `packages/ui/build/bundled-modules.json`, which the UI build writes. If the UI list is missing or does not match `packages/ui/dist`, rebuild the UI. A bundled package without a license also fails the build.

## Release

Run `pnpm release` from the repository root to build and check the package. It prints the publish command without publishing. [`CONTRIBUTING.md`](../../CONTRIBUTING.md#release) describes the release steps.
