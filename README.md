# Sherpa

Sherpa is a local code review tool. The reviewer reads a pull request diff in the browser, while an AI agent in another session of the same harness builds a **route** through it. The route is an ordered narrative of what changed and its consequences. The agent also answers questions right beside the code. The server and UI run on localhost. Sherpa makes external requests only to the PR host, GitHub with your GitHub token, and to the feedback channel when you send feedback.

The UI is a complete review interface: file tree and search, a highlighted diff with context expansion, threads and comment drafts, and ship. All of it keeps working without an agent. The route is a layer over the reader, which works on its own.

For reviewers in a monorepo or on GitHub who receive more PRs than they can read line by line. This is an early build, with the MVP still in development. Bugs and odd behaviour happen. See "Feedback" for where to report them.

## Requirements



- For GitHub PRs, a token: `$GITHUB_TOKEN` → `$GH_TOKEN` → `gh auth token`. No checkout is needed because the PR is read through the API. For the "My files" lens to include CODEOWNERS teams (`@org/team`), the token needs the `read:org` scope.
- For local review, any git repository checkout.
- Node ≥ 22.13 (on the 23 release line, 23.4 or later, because earlier versions lack `node:sqlite`).
- An agent harness: Claude Code (tested) or Codex (supported, tested less). Any other harness works too if it supports skills and can call bash.
- Model: this configuration has been tested with `opus:high` and `gpt-5.60-sol:high`. These are the recommended models.

## Installation

Symlink the `skill` directory into your harness skills directory (use your checkout path):

```
mkdir -p ~/.claude/skills ~/.agents/skills
ln -s ~/src/sherpa-review/skill ~/.claude/skills/sherpa   # Claude Code
ln -s ~/src/sherpa-review/skill ~/.agents/skills/sherpa   # Codex
```

The directory is self-contained: 2 built `.mjs` files (the CLI and server with the UI embedded), zero runtime dependencies. Neither pnpm nor a repository checkout is needed. You can copy it anywhere instead of symlinking it.

To update, run `git pull` in the checkout if you use a symlink, or copy the directory again.

## Starting a review

In an agent session:

```
/sherpa https://github.com/quillmart/quillmart/pull/12345
```

The argument can be a GitHub PR link or a key such as `github-quillmart--quillmart--12345`.

With no argument, or with a directory path, Sherpa starts a local review of everything changed against the base in a git checkout, committed or not. The default base is the merge-base with `origin/HEAD`, `main` or `master`. Tell the agent if you want a different base. Local review does not become a PR review even if the branch has a PR. Its comments are never published externally. The agent in the same session receives them as requests to fix the code and replies in the same threads.

The UI opens in your browser automatically, and the agent prints the link either way. The link is local and contains the access token. Do not publish it. Over SSH or in a headless environment, ask the agent to add `--no-open`, then open the printed link manually.

The agent then runs the loop and waits for tasks from the UI.

### Direct VM access over IPv6

By default, the server listens only on `127.0.0.1`. For network access, start a new server
with `SHERPA_LISTEN_HOST=::`. It accepts IPv6 and IPv4 connections, including local
CLI requests, and `sherpa up` prints a link with the VM's DNS name. The variable takes effect
when the server starts. Restart an existing server to apply it.

This exposes the port on the network interfaces. Token checks still apply, but HTTP
does not encrypt the connection. Use an SSH tunnel or HTTPS proxy for encrypted access.

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

In `.md`, `.markdown` and `.mdown` files, the **Markdown** button renders the document. **Code** returns to the source. Select a few words or a sentence and choose "Ask the agent" to include the exact quote and its line context in the question. Use "Comment" to leave a regular review comment anchored to the same lines and visible in both modes. Changed documents have versions from before and after the edit. Expand omitted context in code mode.

The "My files" lens counts only CODEOWNERS rules that requested you specifically. The PCI DSS lens appears only when the PR touches files in the audit scope. Generated files are muted and count as viewed by default. Right-click a file, or use "⋯" in its card header or the file tree, to copy its path, copy its link on the review host, open it on the host's website or mark it viewed.

File viewed marks sync with the review host in both directions. Your marks go to the host if it supports them, and host marks come back. Local marks win conflicts. Route stop marks, line-level coverage and the "generated files are viewed" default stay local. Viewed content collapses, so the density of code on screen shows your progress. After "Viewed", the screen moves to the next file, or the next stop in the route.

### Comments and ship

Sherpa polls threads from the review host and attaches them to ranges and stops. Stops have counters, filters by author, bot and status, navigation from a thread to its route location, and a source label for AI review comments. Threads the host marks outdated have a "pinned to 9f3c1ab" chip and a button to show them at the old commit. Resolved threads and bots are muted by default.

Publishing has 2 stages. A draft goes to the review host immediately, and accumulated drafts are published as one batch when you finish. Before ship, Sherpa shows a summary of exactly what will be sent. Unfinished comments survive a tab reload. Comments support lists, quotes, headings, tables, checklists, code blocks and strikethrough. The editor has Notion-style shortcuts (`- ` and `1. ` start a list, ``` starts a code block, and Enter and Tab follow list behaviour).

Verdicts are Ship (approves only this snapshot), Sticky ship (carries over to later pushes) and "Request changes". "Publish · N" sends drafts without a verdict. The panel shows only actions the host accepts. On your own GitHub PR and in local review, publishing is the only action. Sticky ship requires host support and permission in the PR settings.

### Agent chat and notes

Select lines in the diff and choose "Ask the agent" in the popover. The question goes to the same session. The answer appears in the chat panel (opened by the agent indicator in the top bar) and stays beside those lines as a collapsible note. Notes stay local and do not go to the review host. One click turns a note into a comment draft marked "quoted from an agent answer". A question without a selection is about the whole PR. While the agent builds a route, the question waits in the queue. The panel and indicator show this.

The agent reads unchanged task context (the PR diff, file text and guides) once per session, so 5 consecutive questions do not require 5 reads of the diff. Chat history is stored per PR. `@` in the palette searches it, including previous iterations, and jumps to the lines if the anchor still exists.

### Iterations: a second pass after a push

When the author pushes another commit, Sherpa detects it without a restart and shows a "Route is stale" banner with the affected stop numbers. "Rebuild the route" builds a second pass. The agent receives the previous route, the difference between iterations and discussion on the affected lines. The server marks stops "changed" / "new" and carries over progress. Stops on untouched lines stay viewed, and the banner shows their count.

"What is new since the last pass" (key `w`) leaves only changed content on screen. Each stop has a "why this stop changed" explanation with thread links. Chat notes move with their lines. Sherpa marks notes that no longer have a target "anchor lost after push" and keeps them in chat.

The snapshot indicator in the top bar opens a menu. Previous snapshots and iterations open read-only (comments and marks are available only in the active iteration). "Show changes since iteration…" opens the difference between 2 pushes without a route. Force-push does not break history. Sherpa reads the snapshot of a vanished commit from a local copy. GitHub has no previous iterations. Review there uses the current branch head.

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

### Interface theme

Light and dark. The button in the top bar shows the current theme and switches it without
a reload. The choice is saved for all PRs and survives restarts. Dark is the default.

### Updates

The server checks the npm registry for a newer published version at most once every 30 minutes. It caches the result so servers for all your PRs do not keep calling the API. If a newer version is published, a toast in the bottom-left corner shows what is new in one sentence and how to update. Nothing downloads or installs automatically. To check now, use the ⌘K palette → "Check for updates". "Do not remind me about X" silences that version only. The next version will appear again.

### Settings

Settings survive startup. Diff mode, ship mode, editor layout, language, theme and onboarding state live in `~/.sherpa/settings.json`, shared by all PRs. Collapsed directories, cards and recent palette commands live in the database for the specific PR.

## Environment variables

All are optional. Sherpa uses defaults when they are absent.

| Variable | Purpose | Default |
|---|---|---|

| `SHERPA_DIR` | Sherpa state root | `~/.sherpa` |
| `SHERPA_PR` | PR key when `--pr` is not set | unset |
| `SHERPA_LISTEN_HOST` | Listen address for a new server. `::` enables IPv6 and IPv4 | `127.0.0.1` |
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

External requests cover the following:


- **GitHub**, only for PRs on github.com, with your token: PR metadata, diff and file contents, threads, drafts and publishing, viewed marks, CODEOWNERS and organisation team membership.
- **Feedback**, only when you click Feedback and have a token for the channel.
- **Update checks** ask the npm registry for the latest published version, at most once every 30 minutes.

There is no telemetry. The server listens on `127.0.0.1` by default. The UI access token lives in the link fragment and is not sent to the server.

## Troubleshooting

**Server log** is at `~/.sherpa/prs/<PR key>/server.log`, in Russian. If the daemon fails to start, the CLI prints the last 20 log lines automatically.

**The server died but left its manifest.** The next launch checks the pid in the manifest and `/healthz` on its port. It moves a stale manifest aside and takes its place automatically. To clean up manually, delete `~/.sherpa/servers/<PR key>.json` while the server is stopped.

**`worker_conflict` and "stop the loop".** Each PR has one worker slot. A new session replaces the old one, which receives an error containing "stop the loop" and stops its loop. This is expected. Continue in the new session. Two agents cannot work on the same PR.

**The server stopped on its own.** After 15 minutes with no open tabs or CLI calls, the PR server stops. There is no `down` command, so it would otherwise stay in memory until the machine restarts. The tab says "Server unavailable, reconnecting…". Run `/sherpa <PR>` again. State lives in SQLite and survives the shutdown.

**The UI says "Agent disconnected".** The server is running, but the worker session was closed, restarted or replaced. The full reader remains available: diff, search, comments, ship and previously built route snapshots. Only new questions and generation are unavailable. "Connect the agent" in the top bar gives you the launch command. Run it in any harness to make the session a worker again.

## Feedback

The Feedback button in the UI creates an issue through the configured feedback channel, with your text and, unless you clear the checkbox, context (version, PR, screen, route phase and worker). You can see the context before sending.

If the feedback channel is unavailable, the button says so and your text stays in the form for copying.

The Feedback form also links to a [project discussion](https://github.com/quillmart/quillmart/discussions) for questions, discussion and feedback without an issue.

## Limits

- One PR per session, one session per PR.
- Hosts are GitHub and a local git checkout.
- Sherpa does not generate its own findings. It shows existing comments, including AI review comments.

## Version

`0.10.0` is printed by `sherpa --version` and shown in the UI top bar.

## Development

The source is next to the distribution: a TypeScript pnpm monorepo, built into two esbuild bundles. [`docs/`](docs/README.md) explains how it works and why. [`CONTRIBUTING.md`](CONTRIBUTING.md) covers building, running and testing.
