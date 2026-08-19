# Sherpa: AI-assisted code review

**Product brief v0.1 · 18.08.2026 · for mockup design**

The working name "Sherpa" describes a guide who leads the reviewer along a route through the diff. The name can change.

---

## 1. In one paragraph

Sherpa is an internal code review tool: a web UI where the reviewer's AI agent prepares a **route through a pull request**, from the heart of the change to its consequences and wiring, with explanations and priorities for the reviewer's attention. The UI fully replaces the review host's interface for code review: a better diff reader with two-way comments and ship. The reviewer follows the route, reads only what matters and reaches a decision sooner, while keeping control of exactly what they approve.

## 2. Problem and context

Pull request volume has grown roughly **5-fold** because AI agents write code. Review has become the bottleneck: reviewers physically cannot read every diff line by line from top to bottom, and the current review host UI does nothing to help them prioritize. Every line looks equally important, and the reviewer has to reconstruct the heart of the change from alphabetically sorted files.

The target user for v1 is the **reviewer**: an engineer on a large team, working in a monorepo, with ownership zones defined by CODEOWNERS and their own agent harness (Claude Code, Codex and others, with a mix of harnesses across the team). The PR author as a separate role is planned for v2.

**Success means:** the reviewer handles 5× the volume without losing quality. Proxy metrics: time from opening a PR to a verdict, the share of the diff they had to read raw, and the number of passes through a PR before ship.

## 3. Product principles

These principles shape the product. Check design decisions against them.

1. **The reader works fully without AI.** The product is a better way to read a diff even when the route has not been generated, is stale or the agent is unavailable. The AI layer is an addition whose failure leaves the reader working.
2. **The route sets the reading order rather than retelling the code.** The reviewer reads the real diff with the same components, comments and marks, in a meaningful order. A summary requires trust. A route is verifiable by construction.
3. **AI prioritizes attention but never silently hides code.** Every collapsed range appears as a fold with a counter. A validator structurally guarantees diff coverage by the route, rather than relying on a prompt. Ranges left without explanations are explicitly marked, so the reviewer always knows where explanations end. *(Other implementations omit this marking, silently losing ~12% of lines.)*
4. **Importance ≠ size.** A dangerous PR is often a small config change. Importance signals (tiers and comment counters, including existing AI review comments) are independent of change volume.
5. **One viewer, two layouts.** The route and full diff traverse the same state in two orders: viewed marks, comments and annotations are shared. In the full diff, the AI layer remains visible but no longer sets the order.
6. **Canonical state lives in the review host.** Comments follow the host's two-stage model: drafts are saved to the host immediately, and the accumulated batch is published when the review finishes (ship or request changes). Reads are reactive. Only reading progress and routes live locally, because the host has neither.
7. **The human decides.** AI never ships, posts or sends anything without an explicit reviewer action. Every AI artifact shows its provenance: what generated it, which model and which commit.

## 4. How it works (architecture in one paragraph)

The reviewer runs the skill in their agent harness → a local server starts and the UI opens in the browser. The invoking agent session stays alive as a **worker**: the server holds a queue of AI tasks (route generation, chat, regeneration), and the agent takes them one at a time and returns results. This brings AI from the harness the reviewer already has. State is stored on disk per PR, and the UI lives per session. The route is a versioned snapshot tied to a commit (CI could prebuild snapshots in v2/v3, which the format already allows). The diff and file set adapt to the user (CODEOWNERS).

**Design implications:** the base protocol guarantees one AI task at a time. This is the minimum shared by all harnesses. Within a task, a harness can run subagents in parallel, for example for route sections, but no harness guarantees parallel execution of queued tasks. Design the UI around a queue with accurate statuses ("Generating the route, your question is next"). An agent session can die, so an "Agent disconnected" state must leave the reader working and give a clear way to reconnect.

## 4a. Host adapter: review hosts and GitHub

Sherpa works through review host adapters, including **git + GitHub**. All host-specific behavior stays in an adapter (diff source, comments and drafts, verdicts, viewed marks, ownership lens, statuses). The core, including the walkthrough, RPC loop, tiers, progress, chat and snapshots, is independent of the host. Data schema rule: host concepts (such as "sticky ship") stay as host verdicts and do not enter the walkthrough model or state.

GitHub adapter behavior compared with the review host model:

| Capability | Review model | GitHub |
|---|---|---|
| "My files" ownership lens | Ownership rules | CODEOWNERS (less expressive, but enough for the lens) |
| PCI DSS lens | Available | **Unavailable, a host-specific capability** |
| Verdict | ship / sticky ship | approve / request changes. Repository settings (dismiss stale reviews) determine whether approval carries over, and the UI shows the actual status |
| Comment drafts | Two-stage model | Pending review (the same model, one pending review per user, visible only to its author) |
| Inline comment outside the diff | Broader support | Only lines inside the diff → falls back to a file comment with a quote |
| Thread updates | Push/reactive API | Polling (~10–15 s per PR, comfortably within rate limits) |
| Snapshots after a force-push | — | Old commits cannot be retrieved reliably → the snapshot patch must be stored locally (already done) |
| Viewed marks | Local + review host | Synchronized with GitHub (GraphQL) |

## 5. Glossary

| Term | Meaning |
|---|---|
| **Route** | AI artifact: an ordered set of stops covering the entire diff. Structured data under a strict schema (not free text), assembled from a fixed set of UI components. Passes fail-closed validation: references to nonexistent files are discarded, and uncovered ranges go to "Other". |
| **Stop** | Route unit: a title, a "what changed → consequences" paragraph (2–4 sentences), a transition, anchors to **line ranges** (a file can span multiple stops), and display directives (what to collapse). |
| **Importance tier** | high / medium / low on a stop and range. Directs attention. low is collapsed by default, with expansion toggles by tier. |
| **"Other"** | Synthetic final stop: everything the model did not place. Explicitly marked as "not placed", rather than "understood". |
| **Snapshot** | Immutable route version: `{content hash, commit, time, provenance}`. A new push → a new snapshot, with old snapshots retained. |
| **AI review comment** | An existing bot comment from the review host. In v1, displayed as a regular comment with a source label and included in stop counters. Generating findings (warnings) is planned for v2. |

## 6. Main screen

The default PR view is the **Triage route**: stops in descending importance ("heart of the change → consequences → wiring"). The reviewer can stop after any one of them, having already seen the most important parts.

**Layout (decided):** **two columns** by default, with route narrative and diff in one stream. The reference is minimalism with full functionality. A third panel (chat, threads, PR overview) opens through an **explicit user action** and can be collapsed, instead of staying open permanently. The default state is optimized for reading code: everything secondary can be collapsed and does not compete with the diff for attention. Dense screens are a reference for what to avoid. Use their mechanisms, but not their layout.

- **A scrolling document, not a step-by-step wizard.** The reviewer keeps peripheral awareness, jumps between anchors, switches freely to the full diff and returns. No Next/Prev steppers or takeover screens.
- Stops contain **real diff viewers** with all their tools: comments, viewed marks, search and context expansion.
- **Two levels of progress:** position ("03 / 07") + what was actually viewed (check marks on stops and files, with viewed content collapsed so progress shows in the density of code on screen). Progress is per user.
- **Review actions stay within reach** (floating panel: PR comment, ship / sticky ship, "Request changes"). The reviewer decides when they are done, independently of the route. Finishing publishes accumulated comment drafts as one batch (the review host's two-stage model), so the panel shows an unpublished counter: "N comments will be published".
- **Reading order preset:** "Triage" (importance order, the default) ↔ "Full tour" (narrative reading order: entry point → definitions → consequences → verification, for PRs the reviewer wants to understand in full). The data stays the same, with a different order and presentation.
- **Fallback:** the "Full diff" tab is a classic reader. The summary, tiers and warnings remain in the diff margin.
- Diff component: unified/split, word-level highlighting, entity headers ("function X changed · 120–164"), collapsed unchanged ranges, muted generated files, tests grouped with their code.

Optional route components (the model inserts them where justified, with no guarantee): architecture diagram (mermaid), key takeaways with severity, manual verification checklist ("Log in and check that the session stays alive").

**Behavioural test digest** (stop component). Test code is hidden by default (it is generated, with nothing to review). Instead, the walkthrough states the contract: a list of assertions in plain language ("Rejects edits after the 30-minute window"), each with a **new / changed / removed-weakened** category and an anchor to a specific test case (click to expand the code). A weakened or removed assertion is a first-class signal that gets lost in a raw test diff. Also show the reverse: "changed behavior without coverage", the behavior in this stop that no assertion covers. Together with the manual verification checklist, this shows "machine-verified / verify by hand / unverified". The validator discards any assertion without an anchor to an existing test.

## 7. End-to-end scenarios (for mockups)

### F1. Triage of a medium-sized PR, the basic scenario
The reviewer runs the skill on a PR → the UI opens immediately with the diff and route skeleton. Stops fill in as they are generated, progressively, starting with the summary and first stop. Reads the summary → goes through high- and medium-tier stops, scrolls past collapsed low-tier stops and "Other" → writes 2 comments along the way (saved instantly to the review host as drafts) → ships from the floating panel. Ship publishes both comments as one batch. Never opened the full diff.

### F2. Deep review of a complex PR
The same PR, but the reviewer switches the preset to "Full tour" → follows all stops in narrative order → selects lines at an unclear point and asks in contextual chat ("Why is the cache invalidated before the write here?"). The question goes to the agent, the answer streams into the chat panel and stays attached to the selected lines as a collapsible agent note → finds a problem, writes a blocking comment → "Request changes".

### F3. Second pass after a new iteration, a main differentiator
The author pushed new commits. The reviewer opens the PR: a banner says "Route built for commit X, PR is already at Y" → starts regeneration (or it started automatically) → a new snapshot. **Progress carries over:** stops whose ranges have not changed stay marked. The UI shows "what is new since your last pass": changed and new stops, with an explanation of *why* they changed (responses to review comments link to the threads). A snapshot version selector + base commit selection for an arbitrary slice (stacked scenario) form one mechanism for navigating the PR timeline.

### F4. Comments from other reviewers (including AI)
The reviewer opens a PR with discussion already underway: colleagues' threads and AI review comments. Route stops show comment counters. Threads appear next to their ranges, with filters (people / bots / resolved / outdated, with resolved threads and bots muted by default) and navigation from a thread to its place in the route. The reviewer replies in a thread. The reply is saved as a draft and published as part of the batch when the review finishes. AI review comments have a source label and follow the same rules, with no special mechanism.

### F5. Reduced functionality without an agent
The reviewer opens saved PR state without running the skill (or the worker session died). The UI is a fully functional reader: diff, search, comments to the review host, ship. AI areas show "Agent disconnected" + reconnection instructions. Previously generated route snapshots remain available to read.

## 8. Functional requirements for v1

**MUST: reader (review host parity or better):**
Search files and diff content. Symbol navigation. Viewed marks (file and stop, per user). Tabs for files and views (route / full diff / PR overview). Open files in an external editor. Full keyboard control + command palette. Virtualization for large diffs. "My files" filter from CODEOWNERS (the default for reviewers with an ownership zone). PCI DSS marking. Generated files shown separately or muted. Tests grouped with source files.

**MUST: review host (two-way):**
Comments and threads: reactive reads, creation/reply/resolve from the UI through the host's two-stage model (drafts saved to the host instantly, accumulated drafts published as one batch when finishing with ship or request changes). Ship and sticky ship. Review statuses. The host owns comment identity (the UI has no comment model of its own).

**MUST: AI route:**
PR summary. Triage route and "Full tour" preset. Structured schema + fail-closed validation + coverage guarantee + marking for unexplained ranges. Importance tiers with folds. Progressive generation (the UI works before the route is ready). Snapshots with provenance and a stale banner. Inline explanations of difficult code as part of stops.

**MUST: comments in the route:** existing review host threads (people and review bots) attached to ranges and stops. Counters on stops. Author/bot/status filters (resolved threads and bots muted by default). Navigation from a thread to its place in the route. Source labels for bots.

**MUST: chat:** contextual chat with the agent (context: PR + selection), a task queue with visible states, chat history per PR. The answer to a question asked from a selection appears in chat and is **attached to that range in the diff** as a collapsible agent note in the margin. After a dozen questions, the answer stays next to the code without scrolling through chat. Navigation works both ways (from chat to the diff location, from a note to the chat thread). Notes are explicitly marked as model answers and are not published to the review host. One click turns a note into a comment draft.

**MUST: feedback about Sherpa itself:** a quick way to report a problem or idea from anywhere in the UI (button + command palette action, minimal friction). Free text, optional category (bug / idea / question), and automatically attached context: Sherpa version, PR, route snapshot, active screen. The product owner turns incoming feedback into issues, so context matters more than the form. Show the attached context before sending. Keep this separate from 👍/👎 reactions on route elements, which rate generation quality rather than the product.

**SHOULD:** behavioural test digests at stops (see section 6), "what is new since the last pass" (full F3, or at minimum progress carryover + snapshot selector if time runs out), base commit selection, optional diagrams, manual verification checklist, 👍/👎 reactions on route elements.

## 9. System states required in mockups

| State | What the reviewer sees |
|---|---|
| Route generating | Diff available immediately, route skeleton, stops appear as they become ready, progress estimate |
| Agent busy | Queue: "Generating the route, your chat question is next" |
| Agent disconnected | Fully functional reader + "Reconnect the agent: …" (skill launch instructions) |
| Stale route | "Built for X, PR at Y" + start regeneration. The old snapshot remains readable, comments warn that they are pinned to an older commit |
| Generation failed | Error with reason + raw model output (can be edited and revalidated) + reader keeps working |
| Review finished | Result: verdict, counters (viewed/commented/warnings), exit |

## 10. Outside v1 scope

**PR list / reviewer inbox is outside v1.** Entry always starts from a specific PR: the skill runs from a session on that PR, and the UI is per PR. There is no "My reviews" screen, and the reviewer chooses the next PR in the review host. Parallel reviews use separate browser tabs (tab title: PR number + title). A prioritized inbox is a v2/v3 candidate if Sherpa becomes a full replacement for the reviewer's host UI (requires a persistent process, a separate architectural step).

**Sherpa's own AI review (warning generation)** is planned for v2. In v1, only existing review host comments are shown, including AI review comments. The feedback loop (confirm/dismiss with reasons, accumulating signal) also moves to v2. Author as a user (pre-reviewing their own PR, author highlights) is v2. CI-prebuilt snapshots as a cache are v2/v3. Structural diff is a v2 candidate with a more specific plan (see `research/difftastic.md`): difftastic as a full diff display mode (with safeguards against false "no changes" results), while agent input uses a "hunks × symbols" layer on tree-sitter (or `sem`) instead of difftastic. The only low-cost option that may fit v1 is a "formatting only" badge from `difft --check-only`, cross-checked against the text diff. Semantic coverage within the diff and deterministic call graph analysis (call flow) are v2 candidates. Diagrams as a guaranteed artifact remain out of scope (only an optional component). Team dashboards and metrics. Export to a sandbox was rejected. Mobile version. Multiple parallel agent workers.

## 11. Open design questions

1. Visual language for importance tiers and comment counters: how to say "look here" without a Christmas tree of badges.
2. How should "what is new since the last pass" look: a separate view, a route filter, a diff of routes?
3. Chat: a slide-out panel or popovers attached to selections, with history in a panel? (Layout is decided: the third column opens on an explicit action, see section 6.)
4. The first PR screen before the route is ready: what to show in the first 10–30 seconds so it does not feel like a waiting room.
5. How to show the boundary between "explained / not explained" in the full diff without distracting the reviewer.

## 12. Appendix: lessons from other tools

**Visual references:** an annotated screenshot gallery with "use / skip" notes (not published).

**Live examples (spend 10 minutes clicking through before starting mockups):**
- Layers, a summary rail on the right, and a Review history dropdown.




- **Scrolling review document.** Use a scrolling document instead of a stepper, a shared state model for route and diff, two levels of progress, the "what → consequence" formula, model display directives, and floating review actions. Gaps in the original design: file-level granularity, no snapshots, no validation of the guide.
- **Layered review.** Use layers defined by line ranges, a synthetic catch-all, complexity to direct attention (low collapsed), snapshots with explicit stale states, progressive streaming, entity headers, and "Prompt for AI Agents". Gaps in the original design: ~12% of lines silently lack explanations, snapshots have no diffs, progress does not carry over.
- **Local server + reviewer's agent.** Use fail-closed validation and the coverage rule, an exploration budget in the prompt ("a slow route is a failed route"), feedback to the agent with "verify, do not fix" instructions (Confirmed/Not a bug/Intended verdicts), and Code Tour narrative mechanics (gist, transitions, checklist). Gaps in the original design: a one-shot feedback loop, no incremental updates, no connection between the guide and findings.
- **Ergonomics:** full keyboard control, virtualization as the basis for working with large diffs.

Sherpa's differentiators across these tools: review host integration (CODEOWNERS, PCI DSS, ship), progress carryover between snapshots + "what is new", explicit marking of unexplained ranges, comments (including AI review comments) inside the route, and an agent worker independent of the harness.
