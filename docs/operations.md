# Running Sherpa

Requirements, configuration, storage, network access and troubleshooting. The [README](../README.md) covers installation and the first review, and [`guide.md`](guide.md) covers the UI.

## Requirements in detail

- **Node 22.13 or later.** On the 23 release line it has to be 23.4 or later, because earlier 23.x versions lack `node:sqlite`.
- **npm**, which comes with Node, for `npx`.
- **For GitHub PRs, a token.** Sherpa looks for `$GITHUB_TOKEN`, then `$GH_TOKEN`, then the output of `gh auth token`. No checkout is needed because the PR is read through the API. If your CODEOWNERS file names teams (`@org/team`) and you want the "My files" lens to include them, the token needs the `read:org` scope.
- **For local review, any git checkout.**
- **An agent harness.** Claude Code is tested. Codex is supported but has had less testing than Claude Code. Any other harness works if it supports skills and can run bash.
- **A model.** This configuration has been tested with `opus:high` and `gpt-5.6-sol:high`, and these are the recommended models.

## How a session works

The `/sherpa-review` skill accepts a PR link, a PR key such as `github-quillmart--quillmart--12345`, or a directory for [local review](../README.md#local-review). With no argument it reviews the current directory. It starts a local server for that review, opens the UI in your browser and keeps the agent session alive as a worker. From then on the UI posts tasks (build the route, answer a question) and the agent picks them up one at a time and returns results. The server validates every result before the UI sees it. The model runs in the harness you already have, with your access rights. Sherpa itself has no model keys.

In a headless environment, ask the agent to add `--no-open` and open the printed link yourself. The link points at the machine's loopback address and contains the access token, so over SSH forward the server port first or see [Access from another machine](#access-from-another-machine).

The skill itself is a stub that runs `npx -y sherpa-review@<version> guide` to get the session instructions, with the exact version of the release you installed. The [`sherpa-review`](https://www.npmjs.com/package/sherpa-review) npm package contains those instructions and 2 built `.mjs` files: the CLI, and the server with the UI embedded. It has zero runtime dependencies. A new version arrives only when you update the skill or the plugin, see [Updating](../README.md#updating). A running session keeps the version it started with, so an update cannot change its commands midway.

## Access from another machine

By default the server listens only on `127.0.0.1`. To reach it over the network, start a new server with `SHERPA_LISTEN_HOST=::`. The server then accepts IPv6 and IPv4 connections, including local CLI requests, and `sherpa-review up` prints a link with the machine's DNS name. The variable is read when the server starts, so restart an existing server to apply it.

This exposes the port on your network interfaces. Token checks still apply, but plain HTTP does not encrypt the connection. Use an SSH tunnel or an HTTPS proxy if you need encryption.

## Environment variables

All of them are optional. Sherpa uses the defaults when a variable is absent.

| Variable | Purpose | Default |
|---|---|---|
| `SHERPA_DIR` | Sherpa state root | `~/.sherpa` |
| `SHERPA_PR` | PR key when `--pr` is not set | unset |
| `SHERPA_LISTEN_HOST` | Listen address for a new server. `::` enables IPv6 and IPv4 | `127.0.0.1` |
| `SHERPA_SERVER_BIN` | Path to the server module | adjacent `sherpa-review-server.mjs` in the package's `bin/` |
| `SHERPA_IDLE_SECONDS` | Debug. Idle shutdown threshold in seconds, `0` disables it | `900` (15 minutes) |
| `SHERPA_WORKER_ID` | Debug. Pins the worker session identity | identity from this PR's `worker-id` file |
| `SHERPA_SERVER` | Debug, UI development server only. Address of the running server for the `/api` proxy | first running server manifest |

## What Sherpa stores and where it connects

All state lives in `~/.sherpa`. Directories are created with mode 0700 and manifests with 0600.

- `servers/<PR key>.json` is the manifest of a running server: port, pid and access token.
- `prs/<PR key>/sherpa.db` is the SQLite database of one PR. It holds route snapshots, progress, chat history and UI state.
- `prs/<PR key>/github-drafts.json` maps draft retry keys to GitHub comments. The drafts themselves live in a pending review on GitHub.
- `prs/<PR key>/local-review.json` holds the comments of a local review, which has no remote host.
- `prs/<PR key>/local-host.json` records the reviewed directory, branch, base and the `--verdicts` instruction.
- `prs/<PR key>/local-iterations/` is the iteration history of a local review: an index and the new sides of changed text files.
- `prs/<PR key>/server.log` is the server log.
- `prs/<PR key>/worker-id` is the worker session identity. It lives in a file because environment variables do not survive separate harness invocations.
- `prs/<PR key>/payload/` holds the task context files the agent reads.
- `prs/<PR key>/blobs/` caches diff images.
- `settings.json` holds global UI settings.

The server and the CLI make 2 kinds of external requests:

- **GitHub**, only for PRs on github.com and only with your token: PR metadata, diff and file contents, threads, drafts and publishing, viewed marks, CODEOWNERS and organisation team membership.
- **The npm registry**, when the skill starts a session: `npx` resolves the latest `sherpa-review` version and downloads it if it is new.

The browser also loads profile photos directly from the URLs GitHub supplies, without the token and without the server. There is no telemetry. The server listens on `127.0.0.1` by default. The UI access token lives in the link fragment, which the browser does not send with the page request. The UI passes it to the Sherpa server in the `Authorization` header of API requests.

## Troubleshooting

**Where the log is.** `~/.sherpa/prs/<PR key>/server.log`, in English. If the daemon fails to start, the CLI prints the last 20 log lines on its own.

**The server died but left its manifest.** The next launch checks the pid in the manifest and `/healthz` on its port, moves a stale manifest aside and takes its place. To clean up by hand, delete `~/.sherpa/servers/<PR key>.json` while the server is stopped.

**`worker_conflict` and "stop the loop".** Each PR has one worker slot. A new session replaces the old one, and the old one receives an error containing "stop the loop" and stops its loop. This is expected: continue in the new session. Two agents cannot work on the same PR.

**The server stopped on its own.** After 15 minutes with no open tabs and no CLI calls, the PR server shuts down, because there is no `down` command and it would otherwise sit in memory until the machine restarts. The tab says "Server unavailable, reconnecting…". Run `/sherpa-review <PR>` again. State lives in SQLite and survives the shutdown.

**The UI says "Agent disconnected".** The server is running, but the worker session was closed, restarted or replaced. The reader keeps working: diff, search, comments, ship and previously built route snapshots. Only new questions and generation wait for an agent. "Connect the agent" in the top bar gives you the launch command. Run it in any harness, and that session becomes the worker.
