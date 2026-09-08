# Sherpa

Sherpa is a local code review tool. The reviewer reads a pull request's diff in the browser, while an AI agent in a neighbouring session of the same harness builds a **route** through it, an ordered account of what changed and its consequences, and answers questions beside the code. The server and UI run on localhost. Sherpa only makes external requests to the review host (using your credentials) and the feedback channel (feedback, when you click the button).

The UI is a complete review interface: file tree and search, a highlighted diff with context expansion, threads and comment drafts, and ship. All of it keeps working without an agent. The route is a layer over the reader, which works on its own.

For reviewers in a monorepo whose PR queue exceeds what they can read line by line. Status: early build, MVP in development. Bugs and oddities happen. There is a place to report them (see "Feedback").

## Requirements

- Credentials for the review host. No separate sign-in or browser OAuth.
- Node ≥ 22.13 (on the 23 release line, 23.4 or later, because earlier versions lack `node:sqlite`).
- An agent harness: Claude Code (tested) or Codex (supported, tested less). Any other harness works too if it supports skills and can call bash.
- Model: this configuration has been tested with `opus:high` and `gpt-5.60-sol:high`. These are the recommended models.

## Installation

Symlink the `skill` directory into the harness's skills:

```
ln -s ~/src/sherpa-review/skill ~/.claude/skills/sherpa   # Claude Code
ln -s ~/src/sherpa-review/skill ~/.codex/skills/sherpa    # Codex
```

The directory is self-contained: 2 built `.mjs` files (the CLI and server with the UI embedded), zero runtime dependencies. Neither pnpm nor a repository checkout is needed. You can copy it anywhere instead of symlinking it.

To update, run `git pull` in the checkout if you use a symlink, or copy the directory again.

## Starting a review

In an agent session:

```
/sherpa https://github.com/quillmart/quillmart/pull/12345
```

The argument can be a GitHub link, a bare PR number (`12345`) or a key such as `github-quillmart--quillmart--12345`. When running from a checkout of the branch under review, you can omit the argument. The PR is discovered from the branch.

The UI opens in your browser automatically, and the agent prints the link either way. The link is local and contains the access token. Do not publish it. Over SSH or in a headless environment, ask the agent to add `--no-open`, then open the printed link manually.

The agent then runs the loop and waits for tasks from the UI.

## Features

### Route

Route generation starts automatically. Once an agent worker connects and the diff loads, the server queues a task. Use "Build the route" on Overview, in the banner or in the command palette to retry after an error, rebuild after a push, or start if automatic generation did not run. Stops appear as they are generated, and the UI works before generation finishes. Each stop has a title, a paragraph explaining "what changed → its consequences", anchors to line ranges and a real diff reader inside. You can comment, mark viewed and expand context right there.

Stops have an importance tier: high / medium / low. Low stops are collapsed by default. A preset switches the order between "Triage" (by importance) ↔ "Full tour" (entry point → definitions → consequences → verification). Ranges the model has not placed go into an "Other" stop marked "not placed", with a button to ask the agent to place them. Unexplained ranges are hatched in the full diff. The route passes validation. References to nonexistent files and claims without anchors are discarded, and the stop shows how many were dropped.

Small PRs (up to 40 changed lines) have no route. The diff opens directly.

### Three views

- **Overview** is the starting view: PR header, "Summary", files grouped by CODEOWNERS ownership zones with "My zone / All" segments, and a "Discussion" card (participants with counters, PR-level threads, and an author filter that leaves only that author's threads in the diff when clicked).
- **Route** combines the narrative and diff in one feed. A third panel for chat and threads opens on demand.
- **Full diff** is a classic reader with a file tree, lenses, search and an AI layer in the margin.

### Diff reader

Unified and split modes, syntax highlighting and word-level highlighting within lines, entity headers ("function X changed · 120–164"), collapsed unchanged ranges and virtualization for large diffs. Images appear as images: "Before / After" side by side, Swipe, Onion Skin, Diff, and 1:1 or Fit scaling.

The "My files" lens only counts ownership rules that requested your review. The PCI DSS lens appears only when the PR actually touches files in the audit scope. Generated files are muted and count as viewed by default. Right-click a file (or "⋯" in the card header and tree) to copy its path, copy a link to the file on the review host, open it on the review host or mark it viewed.

File viewed marks sync with the review host in both directions. Your marks go to the host if it supports them, and host marks come back. Local marks win conflicts. Route stop marks, line-level coverage and the "generated files are viewed" default stay local. Viewed content collapses, so the density of code on screen shows your progress. After "Viewed", the screen moves to the next file, or the next stop in the route.

### Comments and ship

Sherpa polls threads from the review host and attaches them to ranges and stops. Stops have counters, filters by author, bot and status, navigation from a thread to its route location, and a source label for AI review comments. Threads the host marks outdated have a "pinned to 9f3c1ab" chip and a button to show them at the old commit. Resolved threads and bots are muted by default.

Publishing has 2 stages. A draft goes to the review host immediately, and accumulated drafts are published as one batch when you finish. Before ship, Sherpa shows a summary of exactly what will be sent. Unfinished comments survive a tab reload. Comments support lists, quotes, headings, tables, checklists, code blocks and strikethrough. The editor has Notion-style shortcuts (`- ` and `1. ` start a list, ``` starts a code block, and Enter and Tab follow list behaviour).

Verdict: Ship (approves only this snapshot), Sticky ship (carries over to later pushes) and Request changes.

### Agent chat and notes

Select lines in the diff and choose "Ask the agent" in the popover. The question goes to the same session. The answer appears in the chat panel (opened by the agent indicator in the top bar) and stays beside those lines as a collapsible note. Notes stay local and do not go to the review host. One click turns a note into a comment draft marked "quoted from an agent answer". A question without a selection is about the whole PR. While the agent builds a route, the question waits in the queue. The panel and indicator show this.

The agent reads unchanged task context (the PR diff, file text and guides) once per session, so 5 consecutive questions do not require 5 reads of the diff. Chat history is stored per PR. `@` in the palette searches it, including previous iterations, and jumps to the lines if the anchor still exists.

### Iterations: a second pass after a push

When the author pushes another commit, Sherpa detects it without a restart and shows a "Route is stale" banner with the affected stop numbers. "Rebuild the route" builds a second pass. The agent receives the previous route, the difference between iterations and discussion on the affected lines. The server marks stops "changed" / "new" and carries over progress. Stops on untouched lines stay viewed, and the banner shows their count.

"What is new since the last pass" (key `w`) leaves only changed content on screen. Each stop has a "why this stop changed" explanation with thread links. Chat notes move with their lines. Sherpa marks notes that no longer have a target "anchor lost after push" and keeps them in chat.

The snapshot indicator in the top bar opens a menu. Previous snapshots and iterations open read-only (comments and viewed marks are available only in the active iteration). "Show changes since iteration…" opens the difference between 2 pushes without a route. A force-push does not break history: Sherpa reads the snapshot of a disappeared commit from its local copy.

### Keyboard

The whole review works from the keyboard. Press `?` for the full shortcut map or `⌘K` for the command palette.

| Keys | Action |
|---|---|
| `1` / `2` / `3`, `g o` / `g r` / `g d` | Overview, Route, Full diff |
| `j` / `k` | next / previous stop (file in the full diff) |
| `n` / `p` | next / previous unviewed |
| `v` | mark viewed |
| `e` | expand hunk context |
| `x` | collapse or expand a stop |
| `c` / `r` | line comment / thread reply |
| `a` | ask the agent about the selection |
| `f` | find a file (filter files in the tree in the full diff) |
| `/` | search diff contents |
| `d` | diff mode |
| `t` | route preset |
| `w` | "what is new since the last pass" filter |
| `⌘K` / `?` | command palette / shortcut map |
| `⌘⏎` / `⌘⇧⏎` | ship menu / "Request changes" |

### First visit

On the first visit, Sherpa takes you through a short 8-step screen tour. `→` or `Enter` moves forward, `←` goes back, and Esc closes it. To repeat it, open the ⌘K palette → "Replay the onboarding tour".

### Interface language

Russian or English. By default, the agent supplies the language through the skill (`sherpa up --lang`). Without an agent session, it comes from the browser. To change it manually, use the ⌘K palette → "Interface language: English" / ": Russian". "Language: auto (from the agent or the browser)" restores automatic selection. The choice is global, survives restarts and applies to all PRs.

The agent writes the route and chat answers in the same language. Sherpa records the generation language when it builds the route. If you later change the interface language, the provenance indicator names the route language and a banner offers to rebuild it in the new one. The existing route is not translated automatically.

### Updates

The server checks the npm registry for a newer published version at most once every 30 minutes. It caches the result so servers for all your PRs do not keep calling the API. If a newer version is published, a toast in the bottom-left corner shows what is new in one sentence and how to update. Nothing downloads or installs automatically. To check now, use the ⌘K palette → "Check for updates". "Do not remind me about X" silences that version only. The next version will appear again.

### Settings

Settings survive restarts: diff mode, ship mode, editor layout, language and onboarding state live in `~/.sherpa/settings.json` (shared across all PRs). Collapsed directories, cards and recent palette commands live in each PR's database.

## Environment variables

All are optional. Sherpa uses defaults when they are absent.

| Variable | Purpose | Default |
|---|---|---|

| `SHERPA_DIR` | Sherpa state root | `~/.sherpa` |
| `SHERPA_PR` | PR key when `--pr` is not set | unset |
| `SHERPA_SERVER_BIN` | Path to the server bundle | adjacent `sherpa-server.mjs` in the skill directory |



| `SHERPA_IDLE_SECONDS` | Debug. Idle shutdown threshold in seconds, `0` disables it | `900` (15 minutes) |
| `SHERPA_WORKER_ID` | Debug. Pins the worker session identity | identity from this PR's `worker-id` file |
| `SHERPA_SERVER` | Debug, UI development server only. Running server address for the `/api` proxy | first running server manifest |

## Local storage and external requests

All state lives in `~/.sherpa` (directories 0700, manifests 0600):

- `servers/<PR key>.json` is the running server manifest: port, pid and access token.
- `prs/<PR key>/sherpa.db` is this PR's SQLite database: route snapshots, progress, drafts, chat history and UI state.
- `prs/<PR key>/server.log` is the server log.
- `prs/<PR key>/worker-id` is the worker session identity (environment variables do not survive separate harness invocations).
- `prs/<PR key>/payload/` contains task context files the agent reads.
- `prs/<PR key>/blobs/` caches diff images.
- `settings.json` contains global UI settings.
- `update-check.json` caches version checks.

Three things leave the machine:

- **Review host**, using your credentials: diff, file contents, threads, comment publishing, ship, ownership zones, PCI DSS scope.
- **Feedback**, only when you click Feedback and have a token for the channel.
- **Update checks** ask the npm registry for the latest published version, at most once every 30 minutes.

Nothing else: no telemetry. The server listens on `127.0.0.1`. The UI access token lives in the link fragment and never reaches the server.

## Troubleshooting

**Server log** is at `~/.sherpa/prs/<PR key>/server.log`, in Russian. If the daemon fails to start, the CLI prints the last 20 log lines automatically.

**The server died but left its manifest.** The next launch checks the pid in the manifest and `/healthz` on its port. It moves a stale manifest aside and takes its place automatically. To clean up manually, delete `~/.sherpa/servers/<PR key>.json` while the server is stopped.

**`worker_conflict` and "stop the loop".** Each PR has one worker slot. A new session replaces the old one, which receives an error containing "stop the loop" and stops its loop. This is expected. Continue in the new session. Two agents cannot work on the same PR.

**The server stopped on its own.** After 15 minutes with no open tabs or CLI calls, the PR server stops. There is no `down` command, so it would otherwise stay in memory until the machine restarts. The tab says "Server unavailable, reconnecting…". Run `/sherpa <PR>` again. State lives in SQLite and survives the shutdown.

**The UI says "Agent disconnected".** The server is running, but the worker session was closed, restarted or replaced. The full reader remains available: diff, search, comments, ship and previously built route snapshots. Only new questions and generation are unavailable. "Connect the agent" in the top bar gives you the launch command. Run it in any harness to make the session a worker again.

## Feedback

The Feedback button in the UI creates a sub-issue of [#2300](https://github.com/quillmart/quillmart/issues/2300) with your text and, unless you clear the checkbox, context (version, PR, screen, route phase, worker). You can see the context before sending.

The feedback channel needs credentials in the environment that starts the server (see the table above). Without them, the button says the channel is unavailable. Write directly in #2300 or to `@alice` instead.

## Limits

- One PR per session, one session per PR.
- There is one review host.
- Sherpa does not generate its own findings. It shows existing comments, including AI review comments.

## Version

`0.5.0` is printed by `sherpa --version` and shown in the UI top bar.

## Development

The source is next to the distribution: a TypeScript pnpm monorepo, built into two esbuild bundles. [`docs/`](docs/README.md) explains how it works and why. [`CONTRIBUTING.md`](CONTRIBUTING.md) covers building, running and testing.
