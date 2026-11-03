# Sherpa: AI-assisted code review

Sherpa is a guide that leads the reviewer along a route through the diff. This document describes the product: the problem it solves, the principles every design decision is checked against, the vocabulary, the screens, the end-to-end scenarios and the boundary of the first version.

The version number lives in `packages/npm/package.json`. `sherpa-review --version` prints it, and the UI top bar shows it. Release history: `packages/npm/CHANGELOG.md`.

## 1. In one paragraph

Sherpa is a code review tool made of a local server and a web UI. The reviewer's own AI agent prepares a **route through a pull request**: it starts with the heart of the change, then follows its consequences and wiring, and attaches an explanation and a priority to each step. The UI replaces the host's web review interface completely, with a diff reader, two-way comments and ship. The reviewer follows the route, reads only what matters and reaches a decision faster, while keeping control over exactly what they approve.

## 2. Problem and context

The flow of pull requests has grown **by more than a factor of 2** because AI agents now write code. Review has become the bottleneck. A reviewer cannot read every diff line by line from top to bottom, and the usual review host UI does not help them prioritize: every line looks equally important, and the heart of the change has to be pieced together from alphabetically sorted files.

The target user of v1 is the **reviewer**: an engineer on a large team, working in a large monorepo with ownership zones, with their own agent harness (Claude Code, Codex and others, mixed across the team). The PR author as a separate role is planned for v2.

**What counts as success.** The reviewer handles the increased flow without losing quality. The proxy metrics are the time from opening a PR to a verdict, the share of the diff that had to be read raw, and the number of passes through a PR before ship.

## 3. Product principles

These principles shape the product, and every design decision is checked against them.

1. **The reader is complete without AI.** The product lets you read the diff when the route has not been built, is stale, or the agent is unavailable. The AI layer is an addition, and it can lose functionality on its own.
2. **The route sets the reading order. It does not retell the code.** The reviewer reads the real diff with the same components, comments and marks, in a meaningful order. A summary requires trust. A route is verifiable by construction.
3. **AI prioritizes attention but never silently hides code.** Every collapsed block is visible as a fold with a counter. A validator, not the prompt, enforces the route's coverage of the diff. Ranges left unexplained are hatched, so the reviewer always knows where the explanation ends.
4. **Importance is not size.** A dangerous PR is often a small config change. Importance signals (tiers and comment counters, including existing AI review comments) do not depend on the volume of the change.
5. **One viewer, two layouts.** Route and full diff are 2 reading orders over one shared state, not 2 modes with separate state. Viewed marks, comments and notes are shared. In the full diff the AI layer remains but stops setting the order.
6. **The canonical state lives in the host.** Comments use a 2-stage model: a draft is saved to the host immediately, and accumulated drafts are published as one batch when the review finishes (ship or "Request changes"). Reads use polling. The adapter polls the host every few seconds and decides what to reread. Only data the host has no place for lives locally: reading progress, routes and agent notes.
7. **The human decides.** AI does not ship, post or send anything without an explicit reviewer action. Every AI artifact shows its provenance: what generated it, which model, for which commit and in which language.

## 4. How it works

The reviewer launches the skill in their agent harness. A local server starts, and the UI opens in the browser. The calling agent session stays alive as a **worker**. The server holds a queue of AI tasks (the route skeleton, its sections, chat), and the agent takes them one at a time and returns results. The AI comes from the harness the reviewer already has. The server stores state on disk per PR in SQLite, while the UI runs per session. A route is a versioned snapshot tied to a commit. The diff and the set of files adapt to the user through the host's ownership rules.

The protocol promises that AI tasks run one at a time, because that is the minimum capability every harness shares. Within a task the harness can use subagents in parallel (for route sections, for example), but running several queued tasks in parallel is never guaranteed. The UI therefore centres on a queue with accurate statuses: "building the route, your question is next". Agent sessions can die, so an "Agent disconnected" mode falls back to the reader and gives a clear path to reconnect.

`architecture.md` has the details on packages, data flow, storage and the orchestrator. `protocol.md` covers the queue, liveness, versions and endpoints.

## 4a. Host adapter

Everything specific to a host lives in the `ReviewHost` adapter: the diff source, comments and drafts, verdicts, viewed marks, the ownership lens and statuses. The core, which includes the route, the task loop, tiers, progress, chat and snapshots, does not depend on the host. The rule for the data schema is that host concepts such as "sticky ship" stay within host verdicts and never enter the route model or state.

The core has 3 adapters. **GitHub** reviews PRs on github.com through the API, with the key `github-<owner>--<repository>--<number>`. **Local checkout** reviews the working tree of a project directory against a base commit in any git repository, with the key `local-git-<directory>-<hash>`. **Fixture** supplies deterministic data for tests, development mode and the state gallery (`packages/server/src/hosts/fixture/plugin.ts`, PR key `fixture-<name>`). Other hosts and version control systems connect as plugins in their own packages.

So there are 2 real hosts, GitHub and local checkout, and their capabilities differ. GitHub's ownership lens reads CODEOWNERS from the base branch, while in local review the reviewer's ownership zone is the whole diff. Hosts declare additional lenses themselves, such as a PCI DSS audit scope. GitHub has no previous iterations, so a review covers a single branch head. Local review treats each working-tree state as an iteration and keeps the history itself. Its comments stay local because there is no remote host, and publication goes to the agent in the same session: each publication round becomes an agent task, and the agent's replies return to the same threads. The core learns what a host can and cannot do from `HostCapabilities` flags, never from the host's name.

## 5. Glossary

| Term | Meaning |
|---|---|
| **Route** | An AI artifact: an ordered set of stops that covers the entire diff. It is structured data under a strict schema, not free text, and is composed from a fixed set of UI components. It passes fail-closed validation. The validator rejects references to nonexistent files and puts uncovered ranges into "Other". |
| **Stop** | A unit of the route: a title, a paragraph on what changed and what follows from it, a transition, anchors to **line ranges** (not files, because a file can span several stops), and display directives. |
| **Importance tier** | high / medium / low on a stop and on a range. It directs attention. low is collapsed by default, with expansion toggles per tier. |
| **"Other"** | A synthetic final stop for everything the model has not placed. It is marked "not placed", not "understood", and has a button that asks the agent to place the ranges. |
| **Snapshot** | An immutable version of the route with a content hash, commit, iteration, time and provenance. A new push produces a new snapshot. Old snapshots stay saved and readable. |
| **Iteration** | An author's push: a set of commits for which the host provides its diff. Progress, notes and anchors live within an iteration and carry over between iterations. |
| **AI review comment** | An existing bot comment from the host. Sherpa shows it as an ordinary comment with a source label and counts it in stop counters. Generating its own findings is planned for v2. |

## 6. Main screens

A PR has 3 views, available as tabs and through the keys `1` / `2` / `3`: **Overview**, **Route** and **Full diff** (`packages/ui/src/session/views.ts`).

**The starting screen is Overview.** When the review opens, the route is only just being queued and has nothing to show yet, so Overview is the default. It has the PR header, the "Summary" (once the route is built), files by ownership zone with "My zone / All" segments, and a "Discussion" card with participants, counters and the PR threads. Clicking an author leaves only their threads in the diff. Generation starts on its own as soon as the agent worker is connected and the diff has loaded. An explicit action ("Build route" on Overview, in the banner or through a palette command) is needed only to restart, rebuild, or recover from a failed automatic start. Small PRs, up to 40 changed lines, get no route at all, and their default tab is the full diff.

**Route** combines the narrative and the diff in one feed with 2 columns. A third panel for chat and threads opens through an explicit action and can be collapsed, instead of staying open all the time. The default layout serves reading code, so everything secondary can collapse and stays out of the way of the diff.

- **A scrolling document, not a step-by-step wizard.** The reviewer keeps their peripheral view, jumps between anchors, switches to the full diff and comes back. There are no "next / back" wizards and no screens that cover everything.
- **Stops contain real diff viewers** with all their tools: comments, viewed marks, search and context expansion.
- **Progress has 2 levels.** The stop's position in the route, plus the actual viewed state: checkmarks on stops and files, with viewed content collapsed, so progress shows in the density of code on screen. Progress is local and per user.
- **Review actions are always within reach.** PR comments, publishing comments without a verdict, ship or sticky ship, "Request changes". The panel shows only what the host will accept for this PR. On your own GitHub PR and in local review, only publishing comments is available. Finishing publishes the accumulated drafts as one batch, so before ship Sherpa shows a summary of exactly what will go to the host.
- **An order preset switch.** "Triage" (by importance, the default) or "Full tour" (reading order: entry point, then definitions, consequences and verification). The data is shared, and only the order and presentation differ.

**Full diff** is the classic reader with a file tree, lenses and search. The AI layer stays in the margins: hatches on unexplained ranges, chat notes and links to stops.

**The diff component** has unified and split modes, syntax highlighting and word-level highlighting within a line, collapsed unchanged chunks, muted generated files, and virtualization for large diffs. Long lines **wrap** (`white-space: pre-wrap` plus `overflow-wrap: anywhere` in `packages/ui/src/diff-view/diff-view.css`), so the code column never scrolls horizontally. Images are displayed as images: "Before / After" side by side, Swipe, Onion Skin and Diff, at 1:1 scale or fitted to the column width.

**The behavioural test digest** is a stop component. Test code is hidden by default, and the route describes the contract instead: a list of assertions in plain language ("rejects edits after the 30-minute window"), each with a **new / changed / weakened** category and an anchor to a specific test case, which expands the code on click. A weakened or deleted assert is a first-class signal, because it gets lost in a raw test diff. The reverse view is explicit too: **uncovered** lists the behaviour in this stop that no assertion confirms. The validator rejects assertions without an anchor to an existing test, and the stop reports how many assertions were dropped.

Element behaviour and the keyboard model are in `design/SPEC-elements.md`, screens and tokens in `design/README.md`.

## 7. End-to-end scenarios

### F1. Triage of a medium-sized PR, the basic scenario

The reviewer runs the skill on a PR. The UI opens on Overview with the diff and ownership zones, and route generation starts. Stops fill in as generation proceeds, beginning with the skeleton and the summary. The reviewer reads the summary, goes through the high- and medium-tier stops, scrolls past the low-tier stops and "Other" while they stay collapsed, writes 2 comments along the way (each saved to the host as a draft immediately) and ships. Ship publishes both comments as one batch. The reviewer never opens Full diff.

### F2. Deep review of a complex PR

The same PR, but the reviewer switches the preset to "Full tour" and visits every stop in narrative order. At an unclear point they select lines and ask the agent ("why is the cache invalidated before the write here?"). The question enters the queue. The answer arrives **in full** as one task result (the loop has no token streaming, see `protocol.md`) and stays attached to the selected lines as a collapsible agent note. The reviewer finds a problem, writes a blocking comment and chooses "Request changes".

### F3. Second pass after a new iteration

The author pushes new commits. Sherpa notices without a restart and shows a "Route is stale" banner with the affected stop numbers. The reviewer starts a rebuild, which produces a new snapshot. **Progress carries over:** stops whose ranges have not changed stay marked, and the banner reports their count. The "What is new since the last pass" button leaves only changed and new stops on screen, each with a "why it changed" explanation and links to threads. Chat notes move with their lines, and notes that can no longer be attached are marked "anchor lost after push". The snapshot menu opens previous iterations read-only and shows the diff between 2 pushes.

### F4. Comments from other reviewers, including AI

The reviewer opens a PR with an existing discussion: threads from colleagues and AI review comments. Route stops show comment counters. Threads appear beside their ranges, with filters by people, bots and status, and navigation from a thread to its place in the route. Resolved threads and bots are muted by default. The host decides whether a thread is resolved, for example when an issue is closed, even as "won't fix". A reply to a thread is saved as a draft and published as part of the batch when the review finishes.

### F5. Reduced functionality without an agent

The reviewer opens the saved state of a PR without running the skill, or the worker session has died. The UI remains a full reader: diff, search, comments to the host, ship. The AI areas show "Agent disconnected" with reconnection instructions. Previously built route snapshots stay readable.

## 8. v1 functionality

**Reader.** Search by file and by diff content. A file tree, or a hunk outline for a single-file PR. Viewed marks on files and stops, local and per user. The "Overview / Route / Diff" view tabs. Full keyboard control and a command palette (`⌘K`, with the shortcut map on `?`). Virtualization for large diffs. A "My files" lens based on the host's ownership rules, and a PCI DSS lens. Generated files are muted and count as viewed by default. A file context menu to copy the path or link, or open the file on the host. Markdown files have a document view (before and after the change), with questions to the agent from a selected quote and comments on the same lines as in code.

The PCI DSS lens is conditional. The adapter asks the host for the intersection of the files in the reviewed commit with the audit scope, and the filter appears in the list only when the intersection is nonempty (`packages/ui/src/filters/lens-filters.ts`). A banner above the diff then says that the PR touches files in scope. If the scope is not published or the endpoint does not respond, the lens explains the reason instead of presenting itself as empty.

**Host, in both directions.** Reading comments and threads by polling. Creating, replying and resolving from the UI in 2 stages: drafts are saved to the host immediately, and accumulated drafts are published as one batch when finishing. Unfinished drafts survive a tab reload. Comments support lists, quotes, headings, tables, checklists and code blocks. Ship and sticky ship. Review statuses. Sherpa detects and reports when someone else ships before you. Comment identity comes from the host, and the UI has no comment model of its own.

**AI route.** A PR summary. The "Triage" and "Full tour" presets. A structured schema, fail-closed validation, guaranteed coverage and hatching for unexplained ranges. Importance tiers with folds. Progressive generation, so the UI works before the route is ready. Snapshots with recorded provenance and a stale banner. A behavioural test digest. Progress carryover between iterations and a "what is new" view. Selecting a slice between 2 iterations.

**Comments in the route.** Host threads from people and from AI review bots attach to ranges and stops. Counters on stops. Filters by author, bot and status. Navigation from a thread to its place in the route. Source labels for bots. A "pinned to <commit>" chip on outdated threads, with a view of the old commit.

**Chat.** Contextual chat with the agent, with the PR and the selection as context. A task queue with visible states. Per-PR chat history, searchable from the palette with `@`. An answer to a question from a selection appears in chat and **attaches to the range in the diff** as a collapsible agent note in the margin. Navigation works in both directions. Notes are labelled as model answers and are not published to the host. One click turns a note into a comment draft labelled "quoted from the agent's answer".

**Interface language.** Russian or English. It defaults to the agent's language, or to the browser language without an agent session, and can be changed from the palette. The choice is global. The agent writes the route and chat answers in the same language. The route language is fixed at generation time, so changing the interface language offers to rebuild the route instead of translating the old one.

**First visit.** A short 8-step screen tour on first opening, repeatable from the palette.

**Feedback about Sherpa itself.** A UI button and a palette command create an issue with free text, an optional category and automatically attached context (version, PR, screen, route phase, worker). The context is shown before submission, and you can uncheck it.

**Updates.** In a build with an update channel, the server checks for a new version at most once every 30 minutes and shows a toast with release notes and the update command. "Check for updates" in the palette checks right away. The server downloads and installs nothing. A build without an update channel has neither the toast nor the command. The npm distribution has no channel because each new session uses the latest package through npx.

**Deferred.** Thumbs up and thumbs down reactions on route elements (generation quality is separate from product feedback). Opening a file in an external editor. A manual verification checklist, key takeaways and diagrams as stop components.

## 9. System states

| State | What the reviewer sees |
|---|---|
| Route not built | Diff and Overview work. An invitation to build a route, or for a small PR, an explanation of why it is not needed |
| Route building | The route skeleton, stops appearing as they become ready, "still working" during a long generation, cancellation |
| Agent busy | The queue: "building the route, your chat question is next" |
| Agent disconnected | The full reader plus instructions to run the skill |
| Route is stale | "Built for X, PR at Y", the affected stop numbers, rebuild. The old snapshot stays readable |
| Generation failed | An error with its reason, an option to fill an individual stop, and the reader keeps working |
| Review complete | The result: verdict, viewed and published counts, exit |

Every state renders in the state gallery from fixtures. See `testing.md`.

## 10. Outside v1 scope

**A PR list and reviewer inbox.** Entry always starts from a specific PR. The skill runs from a session on that PR, the UI lives per PR, and there is no "my reviews" screen. Choosing the next PR stays on the host. Parallel reviews use separate browser tabs, one per PR, with its number and title in the tab title. There cannot be 2 sessions on the same PR, because a new session displaces the old one.

**Sherpa's own AI review**, meaning generated findings, is v2. For now Sherpa only displays existing host comments, including AI review comments. The model feedback loop also moves to v2, as does the author as a user (reviewing their own PR before review, author highlights). Snapshots built ahead of time in CI as a cache are v2 or v3. Structural diff is a v2 candidate with a more specific plan in `research/difftastic.md`: difftastic as a Full diff display mode, and a tree-sitter-based "hunks × symbols" layer as agent input. Semantic diff coverage and deterministic call-graph analysis are v2 candidates too. Also out of v1: diagrams as a guaranteed artifact, team dashboards and metrics, a mobile version, and multiple parallel agent workers.

**Design sources.** A scrollable document instead of a step-by-step wizard, shared state for route and diff, 2-level progress, the "what changed, what follows" formula and floating final actions. A layer represented as line ranges, a synthetic catch-all, complexity as attention management, snapshots that report when they are stale, progressive generation (a dense screen is a negative reference). Fail-closed validation, the coverage rule, an exploration budget in the prompt and narrative mechanics. Keyboard control and virtualization as the basis for working with large diffs.

What Sherpa adds on top of those sources: review host integration (ownership rules, audit lenses, ship), progress carryover between snapshots and "what is new", explicit marking of unexplained ranges, comments (including AI review comments) inside the route, and an agent worker that runs in any harness.
