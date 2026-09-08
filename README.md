# Sherpa

Sherpa is a local code review tool. The reviewer reads a pull request diff in the browser, while an AI agent
in a neighbouring session of the same harness builds a **route** through the diff, an ordered account of what
changed and its consequences, and answers questions beside the code. The server and UI
run on localhost. Sherpa only makes external requests to the review host (using your host credentials) and to issues
(for feedback, on request).

The UI is also a complete replacement for the review host's review interface: file tree and search, diff highlighting
and context expansion, threads and comment drafts, ship. All of this keeps
working without an agent: the route adds a layer to the reader, which works on its own.

For reviewers in a monorepo whose PR flow exceeds what they can read line by line.
Status: early build, MVP in development. Bugs and oddities happen, and there is somewhere to report them
(see "Feedback").

## Requirements

- Credentials for the review host are required.
  There is no separate login or browser OAuth.
- Node ≥ 22.13 (on the 23 release line, 23.4 or later, because earlier versions lack `node:sqlite`).
- Agent harness: Claude Code (tested) or Codex (listed as supported, tested less).

## Installation

Symlink the `skill` directory into the harness's skills:

```
ln -s ~/src/sherpa-review/skill ~/.claude/skills/sherpa
```

The directory is self-contained: 2 bundled `.mjs` files (CLI and server with embedded UI), zero runtime dependencies,
no pnpm or repository checkout required. You can copy it anywhere instead of symlinking it.

To update, run `git pull` in the checkout (for the symlink) or copy it again.

## Starting a review

In an agent session:

```
/sherpa https://github.com/quillmart/quillmart/pull/12345
```

The argument can be a GitHub link, a bare PR number (`12345`) or a key such as `github-quillmart--quillmart--12345`.
When running from a checkout of the reviewed branch, you can omit the argument. The PR is detected from the branch.

The UI opens in the browser automatically, and the agent always prints the link. The link is local and contains the access
token, so do not publish it anywhere. Over SSH and in a headless environment, automatic opening
is unnecessary: ask the agent to add `--no-open` and open the printed link by hand.

The agent then runs the loop and waits for tasks from the UI. The session is busy while it waits, so ask your own questions
in another session.

## Features

### Route

Build the route explicitly: choose "Build route" on Overview, in the banner or through the command palette.
Stops appear as generation proceeds. The UI works without waiting for it to finish. Each stop has
a title, a "what changed → consequences" paragraph, anchors to line ranges and a real
diff viewer inside. You can comment, mark viewed and expand context right there.

Importance (high / medium / low) directs attention. Low stops are collapsed by default. The reading order
switches with a preset: "Triage" (by importance) ↔ "Full tour" (entry point → definitions →
consequences → verification). Anything the model hasn't placed goes into the "Other" stop
with a "not placed" label and a button to ask the agent to place it. In the full diff, unexplained ranges
have a hatch. The route passes validation. References to missing files and assertions
without anchors are dropped, and the stop reports how many were dropped.

Small PRs (up to 40 changed lines) have no route. The diff opens directly.

### Three views

- **Overview** is the starting view: PR header, "Summary", files by CODEOWNERS ownership zone with
  "My zone / All" segments, and a "Discussion" card (participants with counters, PR threads, clicking an author
  leaves only their threads in the diff).
- **Route** combines narrative and diff in one feed. A third panel (chat, threads) opens
  on demand.
- **Full diff** is a classic reader with a file tree, lenses, search and an AI layer in the margin.

### Diff reader

Unified and split, syntax highlighting and word-level highlighting within a line, entity headers
("function X changed · 120–164"), collapsed unchanged ranges, virtualization for large diffs.
Long lines wrap, so the code column has no horizontal scrolling. Images display
as images: "Before / After" side by side, Swipe, Onion Skin, Diff, 1:1 scale or Fit.

The "My files" lens counts only ownership rules that assigned you. The PCI DSS lens
appears only when the PR actually touches files in the audit scope. Generated files are dimmed
and count as viewed by default. Right-click a file (or use "⋯" in the file card header or tree) to
copy its path, copy its link on the review host, open it on the review host, or mark it viewed.

Viewed marks are local and per-user. Viewed code collapses, so progress shows in the
density of code on screen. After "Viewed", the screen moves to the next file, or in the route,
to the next stop.

### Comments and ship

Review host threads arrive through polling and attach to ranges and stops: counters on stops,
filters by author, bot and status, navigation from a thread to its place in the route, a source label
for AI review comments. Threads the review host marks outdated have a "pinned to 9f3c1ab" chip
and a button to show them at the old commit. Resolved threads and bots are dimmed by default.

Publishing has 2 stages. A draft goes to the review host immediately, and accumulated drafts publish
as one batch when you finish. Before shipping, a summary shows exactly what will be sent. An unfinished
comment survives a tab reload. Comments support lists, quotes, headings,
tables, checklists, code blocks and strikethrough. The composer has Notion-style shortcuts (`- ` and `1. `
start a list, ``` starts a code block, Enter and Tab follow list behaviour).

Verdicts: Ship (approves only this snapshot), Sticky ship (carries over to later pushes)
and "Request changes". If someone ships before you, Sherpa tells you.

### Agent chat and notes

Select lines in the diff, and a popover offers "Ask the agent". The question goes to the same session,
and the answer arrives in the chat panel (opened by the agent pill in the top bar) and stays by those lines
as a collapsible note. The note is local and doesn't publish to the review host, but one click turns it
into a comment draft labelled "quoted from an agent answer". A question without a selection is about the PR
as a whole. While the agent builds the route, questions wait in the queue. The panel and pill show this.

The agent reads unchanged task context (PR diff, file text, guides) once per session:
5 questions in a row don't cost 5 diff reads. Chat history lives per PR. `@` in the palette searches
it, including previous iterations, and takes you to the lines if the anchor still exists.

### Iterations: a second pass after a push

When the author pushes another commit, Sherpa detects it without a restart and shows a "Route is
stale" banner with the affected stop numbers. "Rebuild route" builds a second pass. The agent receives
the previous route, the difference between iterations and discussion on touched lines. The server marks
stops as "changed" / "new" and carries over progress. Stops on untouched lines
stay viewed, and the banner reports their count.

The "What's new since the last pass" button (key `w`) leaves only changed content on screen.
Each stop has a "why it changed" explanation with thread links. Chat notes move along
with the lines. Those that no longer have a target are marked "anchor lost after push" and stay
in chat.

The snapshot pill in the top bar opens a menu. Previous snapshots and iterations open read-only
(comments and marks are available only in the active one). "Show changes since iteration…" opens
the difference between 2 pushes without a route. A force-push doesn't break history. A snapshot of a missing commit
reads from the local copy.

### Keyboard

You can complete the entire review from the keyboard. `?` opens the full shortcuts sheet, `⌘K` opens the command palette.

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

On first opening, Sherpa gives a short tour of the screen: 8 steps, `→` or `Enter` to advance,
`←` to go back, Esc to close. Repeat it with palette ⌘K → "Show onboarding again".

### Interface language

Russian or English. By default, the language comes from the agent. The skill passes it
with `sherpa up --lang`. Without an agent session, the browser language applies. To change it manually: palette ⌘K →
"Interface language: English" / ": Russian". To restore automatic selection, use "Language: Auto".
The choice is global, survives restarts and applies to all PRs.

The agent uses the same language for the route and chat answers. Generation language is fixed when
the route is built. If you change the interface language later, the provenance pill names the route's language,
and a banner offers to rebuild it in the new one. The old route doesn't translate itself.

### Updates

The server compares the skill directory's version with main at most once every 30 minutes. It caches the result,
so servers for all your PRs don't keep hitting the API. If a newer version is published, a toast appears in the bottom left
with a one-sentence description of what's new and how to update. Nothing downloads or installs
automatically. To check now: palette ⌘K → "Check for updates". "Don't remind me about X" silences
only that version. The next one will appear again.

### Settings

Settings survive startup. Diff mode, ship mode, composer layout, language and onboarding
state live in `~/.sherpa/settings.json` (shared across PRs). Collapsed directories, file cards
and recent palette commands live in the individual PR's database.

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
- `prs/<PR key>/sherpa.db` is this PR's SQLite database: route snapshots, progress, drafts, chat history,
  UI state.
- `prs/<PR key>/server.log` is the server log.
- `prs/<PR key>/worker-id` is the worker session identity (environment variables do not survive separate harness invocations).
- `prs/<PR key>/payload/` contains task context files the agent reads.
- `prs/<PR key>/blobs/` caches diff images.
- `settings.json` contains global UI settings.
- `update-check.json` caches version checks.

Three things leave the machine:

- **Review host**, using your credentials: diff, file contents, threads, comment publishing, ship,
  ownership zones, PCI DSS scope.
- **Feedback**, only when you click Feedback and have a token for the channel.
- **Update check** reads `skill/version.json` from main through the review host API, at most
  once every 30 minutes.

Nothing else. There is no telemetry, the server listens on `127.0.0.1`, and the UI access token lives in the fragment
of the link and never reaches the server.

## Troubleshooting

**Server log** lives at `~/.sherpa/prs/<PR key>/server.log`, in Russian. If the daemon never starts,
the CLI prints the last 20 log lines itself.

**The server died but left its manifest.** The next launch checks the PID from the manifest and `/healthz`
on its port. It moves the stale manifest aside and takes its place, so no manual action
is needed. To clean up, you can delete `~/.sherpa/servers/<PR key>.json` while
the server is stopped.

**`worker_conflict` and "stop the loop".** Each PR has one worker slot. A new session displaces the old one,
and the old one receives an error containing "stop the loop" and stops its loop. This is normal behaviour.
Continue in the new session. Two agents cannot work on the same PR.

**The server shut itself down.** After 15 minutes with no open tabs or CLI calls, the PR server
stops. There is no `down` command, otherwise it would sit in memory until the machine restarted.
The tab says "Server unavailable, reconnecting…". Run `/sherpa <PR>` again. The state
lives in SQLite and survives shutdown.

**The UI shows "Agent disconnected".** The server is alive, but the worker session is gone: closed, restarted
or displaced. The full reader still works: diff, search, comments, ship, previously built route
snapshots. Only new questions and generation are unavailable. The "Connect agent" button in the top bar
provides a launch command. Run it in any harness, and the session becomes a worker again.

## Feedback

The Feedback button in the UI creates a child issue under [#2300](https://github.com/quillmart/quillmart/issues/2300)
with your text and, unless you uncheck the box, context (version, PR, screen, route phase, worker).
You can inspect the context before sending.

The feedback channel must be available in the environment where the server runs (see the table above). Otherwise, the button
reports that the channel is unavailable. You can write directly in #2300 instead.

## Limits

- One PR per session, one session per PR.
- There is one review host.
- Sherpa generates no findings of its own. It shows existing comments, including
  AI review comments.

## Version

`0.5.0` is printed by `sherpa --version` and shown in the UI top bar.

## Development

Sources live alongside the distribution: a TypeScript pnpm monorepo, built into 2 esbuild bundles.
How it works and why: [`docs/`](docs/README.md). How to build, run and test:
[`CONTRIBUTING.md`](CONTRIBUTING.md).
