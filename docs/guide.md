# Using Sherpa

The review UI in detail: the three views, the route, the diff reader, comments and verdicts, the agent chat, a second pass after a push, the keyboard and settings. The [README](../README.md) covers installation and the first review. [`operations.md`](operations.md) covers configuration, storage and troubleshooting.

## Vocabulary

Sherpa uses a few words of its own in the UI and in these pages.

| Term | Meaning |
|---|---|
| **Route** | The agent's reading order for the pull request: an ordered list of stops that together cover the whole diff |
| **Stop** | One step of the route: a title, an explanation, anchors to line ranges and a diff reader for those ranges |
| **Tier** | The importance of a stop or a range: high, medium or low. Low stops start collapsed |
| **Ship** | Approving the review. On GitHub this is "Approve", and the approval lasts until the next push |
| **Ownership zone** | The files a CODEOWNERS rule assigns to you or your team. "My zone" shows only those |
| **Lens** | A filter over the set of files, such as "My files" or an audit scope the host declares |
| **Snapshot** | A route built for one commit. A push makes the snapshot stale, and a rebuild creates a new one |
| **Iteration** | One state of the code under review. GitHub has one iteration per review, local review has one per working-tree state |

## Three views

- **Overview** is where a review normally opens. It shows the PR header, the "Summary", files grouped by CODEOWNERS ownership zones with "My zone / All" segments, and a "Discussion" card with the PR-level threads and participant and comment counts. PRs with up to 40 changed lines open in Full diff instead. Click an author there to leave only that author's threads in the diff.
- **Route** puts the narrative and the diff in one feed. A third panel for chat and threads opens on demand.
- **Full diff** is a classic reader with a file tree, lenses, search and an AI layer in the margin.

## The route

Route generation starts on its own. Once an agent worker connects and the diff loads, the server queues the first task. Stops appear as the agent produces them, and the UI is usable before generation finishes. If generation fails, you push another commit, or the automatic start did not happen, use "Build the route" on Overview, in the banner or in the command palette.

Each stop has a title, a paragraph that explains what changed and what follows from it, anchors to line ranges, and a real diff reader inside. You can comment, mark viewed and expand context right there, with the same tools as in the full diff.

Stops carry an importance tier: high, medium or low. Low stops start collapsed. A preset switches the order between "Triage" (by importance) and "Full tour" (entry point, then definitions, consequences and verification). Ranges the model did not place go into an "Other" stop marked "not placed", with a button that asks the agent to place them. In the full diff, unexplained ranges are hatched, so you always know where the explanation ends.

The route passes validation before you see it. Anchors to lines the diff does not change are dropped, and a stop that loses all its anchors goes back to the agent for re-anchoring. Ranges no stop claims stay visible in "Other".

Small PRs, up to 40 changed lines, get no route. The diff opens directly.

### The test digest

A route stop can show a behavioural digest of the tests: new assertions, changed assertions, weaker checks and behaviour with no test. Each assertion links back to its test line. "Show the test code" opens the underlying diff. A weakened or deleted assertion is easy to miss in a raw test diff, which is why the digest flags it. "Uncovered" lists changed behaviour in this stop that the agent found no test for. The validator drops new, changed and weakened assertions without an anchor to a file in the diff, and the stop shows how many were dropped. It does not check that the file is a test or that the assertion text is right.

## Diff reader

In Full diff you choose files from the tree, and the agent's answers stay beside their lines.

The reader has unified and split modes, syntax highlighting, word-level highlighting within lines, entity headers ("function X changed · 120–164"), collapsed unchanged ranges and virtualization for large diffs. Images appear as images: "Before / After" side by side, Swipe, Onion Skin and Diff, at 1:1 or fitted to the column.

In `.md`, `.markdown` and `.mdown` files, the **Markdown** button renders the document and **Code** returns to the source. Select a few words or a sentence and choose "Ask the agent" to send the exact quote with its line context as a question. "Comment" leaves a regular review comment anchored to the same lines, visible in both modes. Changed documents have a version from before and after the edit. Omitted context expands in code mode.

The "My files" lens includes files whose CODEOWNERS rule names your login or a team you belong to. Team membership needs the token scope described in [requirements](operations.md#requirements-in-detail). Generated files are muted and count as viewed from the start. Right-click a file, or use "⋯" in its card header or in the file tree, to copy its path, copy its link on the review host, open it on the host's website or mark it viewed.

Viewed marks on files sync with the review host in both directions: your marks go to the host if it supports them, and the host's marks come back. When they conflict, the local mark wins. Route stop marks, line-level coverage and the "generated files are viewed" default stay local. Viewed content collapses, so unread code stays in view. After "Viewed", the screen moves to the next file, or to the next stop in the route.

## Comments and ship

Sherpa polls threads from the review host and attaches them to ranges and stops. Stops have counters, filters by author, bot and status, navigation from a thread to its place in the route, and a source label on AI review comments. Threads the host marks outdated get a "pinned to 9f3c1ab" chip and a button that shows them at the old commit. Resolved threads and bot threads are muted by default.

Publishing happens in 2 stages. A draft goes to the review host immediately. When you finish, accumulated drafts are published as one batch, and before ship Sherpa shows exactly what will be sent. Unfinished comments survive a tab reload. Comments support lists, quotes, headings, tables, checklists, code blocks and strikethrough. The editor has Notion-style shortcuts: `- ` and `1. ` start a list, ``` starts a code block, and Enter and Tab follow list behaviour.

Verdicts are Ship and "Request changes". "Comment" publishes drafts without a verdict. The panel shows only the actions the host accepts for this PR. Your own GitHub PR allows only Comment. GitHub has no sticky ship: an approval lasts until the next push.

Local review allows only Comment by default. If you tell the agent what to do after approval or a request for changes, it starts the review with `--verdicts` and Ship and "Request changes" become available, with Comment folded into "Request changes". The agent then executes the part of your instruction that matches the verdict, for example commits and opens a PR on Ship.

In local review, publishing sends the comments to the agent in the same session as requests to fix the code, and the agent replies in the same threads. Nothing goes to an external service.

## Agent chat and notes

Select lines in the diff and choose "Ask the agent" in the popover. The question goes to the same agent session. The answer appears in the chat panel, which opens from the agent indicator in the top bar, and stays beside those lines as a collapsible note. Notes are local and never go to the review host. One click turns a note into a comment draft marked "quoted from an agent answer". A question without a selection is about the whole PR. While the agent builds a route, the question waits in the queue, and the panel and indicator say so.

The session instructions tell the agent to read unchanged task context (the PR diff, file text and guides) once per session, so repeated questions do not reread the diff. Chat history is stored per PR. `@` in the palette searches it, including previous iterations, and jumps to the lines if the anchor still exists.

## A second pass after the code changes

When the author pushes another commit, or the working tree changes in local review, Sherpa notices without a restart and shows a "Route is stale" banner. "Rebuild the route" starts a second pass, and the agent receives the previous route and the discussion on the affected lines. The old snapshot stays readable until the new one arrives.

The rest of this section needs a history of iterations, which only local review keeps. GitHub has no previous iterations, so a GitHub review always uses the current branch head, and "What is new" and comparisons between pushes are unavailable there.

In local review the banner lists the affected stops, and the agent also receives the difference between the two iterations. The server marks stops "changed" or "new" and carries your progress over: stops on untouched lines stay viewed, and the banner shows how many.

"What is new since the last pass" (key `w`) leaves only changed content on screen. Each stop has a "why this stop changed" explanation with links to threads. Chat notes move with their lines. A note that lost its target is marked "anchor lost after push" and stays in chat.

The snapshot indicator in the top bar opens a menu. Previous snapshots and iterations open read-only, since comments and marks exist only in the active iteration. To compare 2 iterations without a route, Shift-click the first one in the menu, then click the second.

## Without an agent

The route is a layer on top of a complete review interface. The file tree, search, the highlighted diff with context expansion, threads, comment drafts and previously built route snapshots work without an agent, and so does publishing the review. Only new questions and route generation wait for an agent. [Reconnecting an agent](operations.md#troubleshooting) is described with the other recovery steps.

## Keyboard

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

## First visit

On the first visit Sherpa takes you through a short 8-step tour of the screen. `→` or `Enter` moves forward, `←` goes back, and "Skip tour" closes it. To see it again, choose "Replay onboarding" in the Settings menu in the top bar, or "Replay the onboarding tour" in the ⌘K palette.

## Interface language

The interface is available in English and Russian. By default the agent supplies the language through the skill (`sherpa-review up --lang`). Without an agent session, the language comes from the browser. To change it by hand, use the Language control in the Settings menu (Auto, EN, RU) or the ⌘K palette: "Interface language: English", "Interface language: Russian" and "Language: auto (from the agent or the browser)", which restores automatic selection. The choice is global, survives restarts and applies to all PRs.

The agent writes the route and chat answers in the same language. Sherpa records the generation language when it builds the route. If you later change the interface language, the provenance indicator names the route language and a banner offers to rebuild it in the new one. The existing route is not translated.

## Interface theme

The Settings menu in the top bar has a Theme control with Auto, Dark and Light. Auto is the default and follows the system theme, an explicit choice does not. The theme switches without a reload. The choice is saved for all PRs and survives restarts.

## Settings

Settings survive a restart. Diff mode, ship mode, editor layout, language, theme and onboarding state live in `~/.sherpa/settings.json`, shared by all PRs. Collapsed directories, cards and recent palette commands live in the database of the specific PR.
