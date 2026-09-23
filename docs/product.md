# Sherpa: AI-assisted code review

The current version is `0.5.0` (in the root `package.json`, also printed by `sherpa --version` and shown in the UI top bar).

Sherpa is a guide that leads the reviewer along a route through the diff.

---

## 1. In one paragraph

Sherpa is a code review tool: a local server and web UI where the reviewer's AI agent prepares a **route through the pull request**, from the heart of the change to consequences and wiring, with explanations and attention priorities. The UI fully replaces the review host for reviewing: a diff reader with two-way comments and ship. The reviewer follows the route, reads what matters and reaches a decision faster while keeping control of exactly what they approve.

## 2. Problem and context

The flow of pull requests has grown **more than 2-fold** because AI agents write code. Review has become the bottleneck: the reviewer physically cannot read every diff line by line from top to bottom, and the current UI (review host) does not help prioritize. All lines look equally important, and the reviewer has to reconstruct the heart of the change from files sorted alphabetically.

The v1 target user is the **reviewer**: an engineer on a large team working in a monorepo (quillmart/quillmart), with ownership zones defined by CODEOWNERS and their own agent harness (Claude Code, Codex and others, teams use a whole zoo of them). The PR author as a separate role is v2.

**What counts as success.** The reviewer handles the increased flow without losing quality. Proxy metrics are time from opening a PR to a verdict, the share of the diff that had to be read raw, and the number of passes through a PR before ship.

## 3. Product principles

These principles shape the product. Every design decision is checked against them.

1. **The reader is complete without AI.** The product lets you read the diff even if the route hasn't been built, is stale or the agent is unavailable. The AI layer is an addition that can lose functionality independently.
2. **The route sets the reading order rather than retelling the code.** The reviewer reads the real diff with the same components, comments and marks, in a meaningful order. A summary requires trust. A route is verifiable by construction.
3. **AI prioritizes attention but never silently hides code.** Every collapsed block is visible as a fold with a counter. A validator, not the prompt, enforces route coverage of the diff. Ranges left unexplained have a hatch, so the reviewer always knows where the explanation ends.
4. **Importance ≠ size.** A dangerous PR is often a small config change. Importance signals (tiers and comment counters, including existing AI review comments) are independent of change volume.
5. **One viewer, two layouts.** Route and full diff are 2 reading orders over one shared state, rather than 2 modes with separate state. Viewed marks, comments and notes are shared. In the full diff the AI layer remains, but stops setting the order.
6. **Canonical state lives in the review host.** Comments follow the host's two-stage model. A draft is saved to the host immediately, and accumulated drafts are published as one batch when the review finishes (ship or "Request changes"). Reads use polling. Every 7 seconds, the adapter calls a lightweight PR endpoint and rereads threads only if `updated_at` or the active iteration changes. Only data absent from the host lives locally: reading progress, routes and agent notes.
7. **The human decides.** AI doesn't ship, post or send anything without an explicit reviewer action. Every AI artifact shows its provenance: what generated it, which model, for which commit and in which language.

## 4. How it works

The reviewer starts the skill in their agent harness → a local server starts and the UI opens in the browser. The calling agent session stays alive as a **worker**: the server keeps a queue of AI tasks (route skeleton, sections, chat), and the agent takes them one at a time and returns results. The AI therefore comes from the harness the reviewer already has. The server stores state on disk per PR (SQLite), while the UI lives per session. A route is a versioned snapshot tied to a commit. The diff and file set adapt to the user through ownership rules.

The protocol promises that AI tasks run one at a time, the minimum shared capability across harnesses. Within a task the harness can use subagents in parallel (for example, for route sections), but running several queued tasks in parallel is never guaranteed. The UI therefore centres on a queue with accurate statuses: "building the route, your question is next". Agent sessions can die, so an "Agent disconnected" mode falls back to the reader and provides a clear path to reconnect.

More details: `architecture.md` (packages, data flow, storage, orchestrator), `protocol.md` (queue, liveness, versions, endpoints).

## 4a. Host adapter

Everything specific to a host lives in the `ReviewHost` adapter (diff source, comments and drafts, verdicts, viewed marks, ownership lens, statuses). The core, including the route, task loop, tiers, progress, chat and snapshots, is independent of the host. The data schema rule is that host concepts (for example, "sticky ship") stay within host verdicts and never enter the route model or state.

There are 3 adapters: **review host** for pull request review, **local checkout** for reviewing a project directory's working tree against a base commit (key `local-git-<directory>-<hash>`), and **fixture** for deterministic data in tests, development and the state gallery (`packages/server/src/hosts/select.ts`, PR key `fixture-<name>`).

There are 2 real hosts: the remote review host and the local checkout. Some capabilities depend on the remote host, including ownership rules and the PCI DSS lens. Local review treats each working-tree state as an iteration and keeps its own history. Its comments remain local, with no remote host. Publishing sends them to the agent in the same session. Each published round becomes a task, and the agent's replies appear in the same threads. The core learns what a host supports from `HostCapabilities` flags, rather than checks against its name.

## 5. Glossary

| Term | Meaning |
|---|---|
| **Route** | An AI artifact, an ordered set of stops covering the entire diff. Structured data under a strict schema (not free text), composed from a fixed set of UI components. Passes fail-closed validation. The validator rejects references to nonexistent files and puts uncovered ranges in "Other". |
| **Stop** | A route unit with a title, a "what changed → what follows" paragraph, a transition, anchors to **line ranges** (not files, since a file can span stops), and display directives. |
| **Importance tier** | high / medium / low on a stop and range. Directs attention. low is collapsed by default, with expansion toggles by tier. |
| **"Other"** | A synthetic final stop for everything the model hasn't placed. Marked "not placed", rather than "understood". Has an "ask the agent to place the ranges" button. |
| **Snapshot** | An immutable route version with a content hash, commit, iteration, time and provenance. A new push → a new snapshot, while old snapshots stay saved and readable. |
| **Iteration** | An author push: a set of commits for which the review host provides its diff. Progress, notes and anchors belong to an iteration and carry over between iterations. |
| **AI review comment** | An existing bot comment from the review host. Sherpa shows it as an ordinary comment with a source label and includes it in stop counters. Generating its own findings is planned for v2. |

## 6. Main screens

Three views of one PR, available as tabs and through keys `1` / `2` / `3`: **Overview**, **Route**, **Full diff** (`packages/ui/src/session/views.ts`).

**The initial screen is Overview.** On opening, route generation is only just being queued, so there is nothing to read in the route yet. Overview is the default: the PR header, "Summary" (when the route is ready), files grouped by CODEOWNERS ownership zones with "My zone / All" segments, and the "Discussion" card with participants, counters and PR-level threads. Clicking an author leaves only their threads in the diff. Generation starts automatically once a worker agent is connected and the diff has loaded. An explicit action ("Build the route" on Overview, in the banner or through the command palette) is needed to restart, rebuild or recover when automatic startup did not work. Small PRs (up to 40 changed lines) have no route at all, and the default tab is Full diff.

**Route** combines narrative and diff in one feed with 2 columns. A third panel (chat, threads) opens through an explicit action and can be collapsed, instead of staying open permanently. The default supports reading code. Everything secondary can collapse and stays out of the way of the diff.

- **A scrolling document, not a step-by-step wizard.** The reviewer keeps their peripheral view, jumps between anchors, switches freely to the full diff and returns. No "next / back" wizards or screens that cover everything.
- Stops contain **real diff viewers** with all their tools: comments, viewed marks, search and context expansion.
- **Progress has 2 levels.** The stop's position in the route plus actual viewed state (checkmarks on stops and files, with viewed content collapsed, so progress is visible in the density of code on screen). Progress is local and per-user.
- **Final actions stay within reach.** PR comment, ship / sticky ship, "Request changes". Finishing publishes accumulated drafts as one batch, so before ship Sherpa shows a summary of exactly what will go to the review host.
- **Order preset switch.** "Triage" (by importance, the default) ↔ "Full tour" (reading order: entry point → definitions → consequences → verification). The data is shared, while order and presentation differ.
- **Full diff** is the classic reader with a file tree, lenses and search. The AI layer stays in the margins with hatches on unexplained ranges, chat notes and links to stops.

**Diff component:** unified/split, syntax highlighting and word-level highlighting within a line, entity headers ("function X changed · 120–164"), collapsed unchanged chunks, muted generated files and virtualization for large diffs. Long lines **wrap** (`white-space: pre-wrap` + `overflow-wrap: anywhere` in `packages/ui/src/diff-view/diff-view.css`), so the code column has no horizontal scrolling. Images appear as images: "Before / After" side by side, Swipe, Onion Skin, Diff, with 1:1 or Fit scaling.

**Behavioural test digest** (a stop component). Test code is hidden by default. The route describes the contract instead: a list of assertions in plain language ("rejects edits after the 30-minute window"), each with a **new / changed / weakened** category and an anchor to a specific test case (click to expand the code). A weakened or deleted assert is a first-class signal that gets lost in a raw test diff. The reverse view is explicit too: **uncovered** lists the behaviour in this stop that no assertion confirms. The validator rejects assertions without an anchor to an existing test, and the stop reports how many assertions were dropped.

Element behaviour and the keyboard model are in `design/SPEC-elements.md`, screens and tokens in `design/README.md`.

## 7. End-to-end scenarios

### F1. Triage of a medium-sized PR, the basic scenario
The reviewer starts the skill on a PR → the UI opens on Overview with the diff and ownership zones → starts building the route. Stops fill in as generation proceeds, starting with the skeleton and summary. Reads the summary → goes through high- and medium-tier stops, scrolls past low-tier stops and "Other" while they remain collapsed → writes 2 comments along the way (instantly saved to the review host as drafts) → ships. Ship publishes both comments as one batch. Never opened Full diff.

### F2. Deep review of a complex PR
The same PR, but the reviewer switches the preset to "Full tour" → visits every stop in narrative order → selects lines at an unclear point and asks the agent ("why is the cache invalidated before the write here?"). The question enters the queue, the answer arrives **in full** as one task result (the loop has no token streaming, see `protocol.md`) and stays attached to the selected lines as a collapsible agent note → finds a problem, writes a blocking comment → "Request changes".

### F3. Second pass after a new iteration
The author pushes new commits. Sherpa detects this without a restart and shows a "Route is stale" banner with the affected stop numbers → the reviewer starts a rebuild → a new snapshot. **Progress carries over:** stops whose ranges haven't changed stay marked, and the banner reports their count. The "What is new since the last pass" button leaves only changed and new stops on screen, each with a "why it changed" explanation and links to threads. Chat notes move with their lines. Notes that can no longer be attached are marked "anchor lost after push". The snapshot menu opens previous iterations in read-only mode and the diff between 2 pushes.

### F4. Comments from other reviewers (including AI)
The reviewer opens a PR with an existing discussion: colleagues' threads and AI review comments. Route stops show comment counters. Threads appear at their ranges, with filters (people, bots, status) and navigation from a thread to its place in the route. Resolved threads and bots are muted by default. The host decides whether a thread is resolved, for example, when an issue is closed, even as "won't fix". A thread reply is saved as a draft and published in the batch on completion.

### F5. Reduced functionality without an agent
The reviewer opens saved PR state without starting the skill (or the worker session has died). The UI is a complete reader with the diff, search, comments to the review host and ship. AI areas show "Agent disconnected" and reconnection instructions. Previously built route snapshots remain readable.

## 8. v1 functionality

**Reader:** search by file and diff content. A file tree, or a hunk outline for a single-file PR. Entity headers. Viewed marks (file and stop, local, per-user). The "Overview / Route / Full diff" view tabs. Full keyboard control and a command palette (`⌘K`, shortcut map with `?`). Virtualization for large diffs. The "My files" lens based on CODEOWNERS review rules and an audit lens. Generated files are dimmed and count as viewed by default. The file context menu copies the path and link or opens the file in the repository. Markdown files can be viewed as documents (before / after the change), with questions to the agent from a selected quote and comments on the same lines as in code.

The PCI DSS lens is conditional. The adapter asks the review host for the intersection of files in the reviewed commit with the audit scope. The filter appears in the list only when the intersection is nonempty (`packages/ui/src/filters/lens-filters.ts`). A banner then appears above the diff saying the PR touches files in scope. If the scope is unpublished or the endpoint didn't respond, the lens explains the reason instead of pretending the result is empty.

**Review host (two-way):** comments and threads support polling reads, creation, replies and resolution from the UI through a two-stage model (drafts go to the review host immediately, accumulated drafts publish as a batch on completion). Unfinished draft text survives tab reloads. Comments support lists, quotes, headings, tables, checklists and code blocks. Ship and sticky ship. Review statuses. Sherpa notices and reports when someone ships before you do. Comment identity comes from the host, the UI has no separate comment model.

**AI route:** PR summary. "Triage" and "Full tour" presets. A structured schema, fail-closed validation, guaranteed coverage and hatching for unexplained ranges. Importance tiers with folds. Progressive generation, so the UI works before the route is ready. Snapshots with recorded provenance and a stale banner. A behavioural test digest. Progress carryover between iterations and a "what is new" view. Selection of a slice between 2 iterations.

**Comments in the route:** review host threads (people and review bots) attach to ranges and stops. Counters on stops. Filters by author, bot and status. Navigation from a thread to its place in the route. Source labels for bots. A "pinned to <commit>" chip on outdated threads, displayed on the old commit.

**Chat:** contextual chat with the agent (PR and selection as context), a task queue with visible states, per-PR chat history searchable from the palette (`@`). An answer to a question from a selection appears in chat and **attaches to the range in the diff** as a collapsible agent note in the margin. Navigation works both ways. Notes are labelled as model answers and aren't published to the review host. One click turns a note into a comment draft marked "quoted from the agent's answer".

**Interface language:** Russian or English. Defaults to the agent's language, or the browser language without an agent session. Change it from the palette. The choice is global. The agent writes the route and chat answers in the same language. The route language is fixed at generation time. Changing the interface language offers to rebuild the route instead of translating the old one.

**First visit:** a short, 8-step screen tour on first opening, repeatable from the palette.

**Feedback about Sherpa itself:** a UI button and a palette command create an issue with free text, an optional category and automatically attached context (version, PR, screen, route phase, worker). The context appears before submission, and its checkbox can be cleared.

**Updates:** the server compares the skill directory version with main (at most once every 30 minutes) and shows a toast with what is new and the update command. Nothing downloads or installs automatically.

**Deferred:** 👍/👎 reactions on route elements (generation quality is separate from product feedback). Opening a file in an external editor. A manual verification checklist, key takeaways and diagrams as stop components.

## 9. System states

| State | What the reviewer sees |
|---|---|
| Route not built | Diff and Overview work. An invitation to build a route (for a small PR, an explanation of why it isn't needed) |
| Route building | Route skeleton, stops appearing as they become ready, "still working" during long generation, cancellation |
| Agent busy | Queue: "building the route, your chat question is next" |
| Agent disconnected | Full reader plus instructions to run the skill |
| Route is stale | "Built for X, PR at Y", affected stop numbers, rebuild. The old snapshot stays readable |
| Generation failed | Error with a reason, an option to fill an individual stop, the reader keeps working |
| Review complete | Result: verdict, viewed and published counts, exit |

Every state renders in the state gallery using fixtures. See `testing.md`.

## 10. Outside v1 scope

**PR list and reviewer inbox.** Entry always starts from a specific PR. The skill runs in a session for that PR, the UI lives per PR, there is no "my reviews" screen, and the reviewer chooses the next PR in the review host. Parallel reviews mean several browser tabs, one per PR (the title shows its number and name). Two sessions cannot share a PR, a new session replaces the old one.

**Sherpa-generated AI review** (generating findings) is planned for v2. For now, Sherpa only displays existing comments from the review host, including review bot comments. The model feedback loop also moves to v2. PR authors as users (reviewing their own PR before submission, author highlights) are planned for v2. Snapshots built ahead of time in CI as a cache are planned for v2/v3. Structural diff is a v2 candidate with a more specific plan (`research/difftastic.md`): difftastic as a full-diff display mode, with a tree-sitter layer of "hunks × symbols" as agent input. Semantic coverage within the diff and deterministic call-graph analysis are v2 candidates. Diagrams as a guaranteed artifact. Team dashboards and metrics. A mobile version. Multiple parallel worker agents.

**Design choices.** A scrolling document instead of a step-by-step wizard, shared route and diff state, 2-level progress, the "what → consequence" formula and floating final actions. Layers as line ranges, a synthetic catch-all, complexity managed through attention, snapshots that show when they are stale, progressive generation and entity headers. Dense screens are a counterexample. Fail-closed validation, the coverage rule, an exploration budget in the prompt and narrative mechanics. Keyboard navigation and virtualization underpin work with large diffs.

Sherpa combines review host integration (CODEOWNERS, PCI DSS, ship), progress carryover between snapshots and "what is new", explicit marking of unexplained ranges, comments (including AI review comments) inside the route, and an agent worker independent of the harness.
