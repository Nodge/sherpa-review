# Handoff: Sherpa — AI-assisted code review (route over the diff)

> **The `*.dc.html` prototypes are a reference, not a source of code.** They load React and fonts from the internet
> (unpkg, Google Fonts) and do not open in a restricted network. To serve them locally, run `python3 -m http.server`
> in this directory. Do not implement the prototype's SCENARIOS button.
>
> **Addendum dated 2026-08-26.** Context bridges, the icon set, the modal for
> modal, composer (including line comments) and the "Discussion" card are described
> in `SPEC-additions-2026-08-26.md`. The live mockup is `Sherpa Additions.dc.html`. It also clarifies
> §Assets (icon set instead of font glyphs) and §3 (publishing drafts as one batch on Ship).
> The context bridge is already implemented in `Sherpa.dc.html`.
>
> **Addendum dated 2026-09-02: onboarding.** Everything else in this handoff is already
> coded. The new scope is only the onboarding tour: 8 tips over the live interface.
> Implementation spec: `SPEC-onboarding-2026-09-02.md` (step copy, anatomy, positioning
> algorithm, states, display flags, reduced functionality, a11y, telemetry, acceptance checklist).
> Storyboard with 1:1 cards: `Sherpa Onboarding.dc.html`. Reference implementation in
> `Sherpa.dc.html`: "07 · First run" in the SCENARIOS dock and the palette command
> «Replay the onboarding tour».

## Overview

Sherpa is an internal code-review UI. An AI agent running in the reviewer's own agent harness
(Claude Code, Codex, …) prepares a **route** through a pull request — an ordered set of stops that
covers the whole diff, from the heart of the change to its consequences and glue — while the UI
itself is a full replacement for the current review tool: a diff reader with two-way comments and
ship. The reviewer walks the route, reads only what matters, and decides faster without losing
control over what they are signing off.

Product principles that shape the UI (do not design them away during implementation):

1. **The reader is complete without AI.** Diff, search, comments, ship must work when the route is
   missing, stale, or the agent is dead. The AI layer degrades independently.
2. **The route sets reading order, it does not retell the code.** Every stop shows the real diff in
   real diff components.
3. **AI prioritises attention, never silently hides code.** Everything collapsed is visible as a
   collapsed block with a counter; coverage of the diff is guaranteed structurally by a validator,
   and ranges left without explanation are explicitly marked.
4. **Importance ≠ size.** A 6-line CODEOWNERS change can outrank a 200-line refactor.
5. **One viewer, two orders.** Route and full diff share one state (viewed marks, comments, notes).
6. **Canonical state lives in the review backend**: a comment draft is
   saved immediately, the accumulated batch is published on ship / request-changes.
7. **The human decides.** Nothing is posted or shipped without an explicit action, and every AI
   artefact shows its provenance (harness, model, commit).

## About the design files

`Sherpa.dc.html` in this bundle is a **design reference created in HTML** — a clickable prototype
that shows intended look and behaviour. It is not production code to copy. The task is to
**recreate these screens in the target codebase's environment** (React/TS in the existing app, its
router, its data layer) using established patterns there. Where this document gives exact hex,
px and copy values, match them; where it describes behaviour, implement it with the codebase's own
primitives (virtualised lists, keyboard-shortcut registry, etc.).

The prototype has a **prototype-only affordance** that must NOT be implemented: the dashed
`SCENARIOS` button in the top bar and its dropdown. It exists to jump between mocked states during
demos. Everything else is product UI.

## Fidelity

**High-fidelity.** Final colours, typography, spacing, density, copy and interaction behaviour.
Layout is designed for a desktop window ≥1440px wide (the prototype sets `min-width: 1440px`).
No mobile layout in v1.

---

## Screens / views

The app is one PR-scoped workspace. Top-level views are tabs: **Overview · Route · Full diff**.
The prototype covers 13 states; each is listed below with the state that produces it.

### 0. Top bar (all views)

Sticky, height 46px, background `#0d0e10`, bottom border `1px solid #22252b`, horizontal padding 14px, gap 14px.

| Element | Spec |
|---|---|
| Product mark | 15×15px `#7f8cff` square, `border-radius:3px`, `transform:rotate(45deg)`, opacity .9 |
| Wordmark | "Sherpa", 13px/600, `#e9eaee`, letter-spacing −.01em; version "0.4.1" 10px mono `#6b7078` |
| Breadcrumb | `quillmart/quillmart` / `PR 4821` — 11.5px mono, `#9ba1ab`, separator `#4a4f57` |
| View tabs | Segmented control: container `#161819`, border `1px solid #24272d`, radius 8px, padding 3px; each button height 24px, padding 0 10px, radius 6px; active `background:#2b2f36; color:#f0f1f4; font-weight:500`; inactive `transparent / #8a8f98` |
| Agent status | Ghost button, height 28px, border `1px solid #24272d`, radius 7px. 6px status dot: connected `#6cc38f`, working `#e2954c`, failed `#e0736c`, disconnected `#6b7078`. Label: "Agent · claude-code" / "Agent working · 1 in queue" / "Agent disconnected". Click toggles the chat panel. |
| Search | Ghost button "Search" + ⌘K key hint (10.5px mono, border `1px solid #2b2f36`, radius 4px). Opens the command palette. |
| Feedback | Ghost button "Feedback" — opens the report-a-problem form (free text, optional category, auto-attached context: Sherpa version, PR, snapshot, active screen; context shown before sending). |
| Avatar | 24px circle `#2b2f36`, initials 10.5px/600 |

### 1. Route — triage (the main screen; `view:'route', preset:'triage', gen:'ready'`)

Two columns in one scrollable document. **Not a stepper**: no next/prev, no takeover.

**PR header** (padding 26px 30px 0): meta line 11px mono — `+806` `#86d9a8`, `−56` `#e8a29c`, "18 files",
branch, then the **PCI DSS filter chip** (see Filters). Title 22px/600, letter-spacing −.015em,
line-height 1.25, `text-wrap:pretty`. Author row 12.5px `#9ba1ab` with an 18px avatar. On the right,
a snapshot selector: height 30px, `#161819`, border `1px solid #24272d`, radius 7px, 11px mono label
`snapshot 9f3c1ab · current` (or `· stale`).

**Sticky toolbar** (top:46px, z-index 30, background `rgba(13,14,16,.92)`, `backdrop-filter:blur(8px)`,
bottom border `1px solid #1e2126`, padding 10px 30px 11px):

- Preset segmented control **Triage | Full tour** + hint text 12px `#6b7078`
  ("Most important first — stop whenever you have seen enough." / "Reading order: entry point →
  definitions → consequences → verification.")
- Diff-mode toggle — deliberately quiet: borderless mono button, 11px `#5e636b`, `⇄ unified` /
  `⇄ side by side`, hover `#9ba1ab`. Global: applies to every file in every view.
- File filter select (see Filters).
- Divider 1×18px `#26292f`, label "Comments from" 12px `#6b7078`, then three additive toggle chips
  `People 3` `Bots 2` `Resolved 1` — height 24px, radius 6px; on: border `#2f333a`, bg `#22252b`,
  color `#e0e2e7`; off: border `#22252b`, transparent, `#6b7078`. Default: people on, bots and
  resolved off.
- **Coverage strip** (second row): 7px tall, radius 4px, track `#181a1e`, 1px gaps. Segments are
  proportional to changed lines and carry `title` tooltips: high `#e2954c` 21.8%, medium `#4a5160`
  40.4%, low `#2b2f36` 33.9%, **not explained** 3.9% rendered as
  `repeating-linear-gradient(115deg,#33373e 0 3px,#1b1e22 3px 6px)`. Legend 11px mono: "862 changed
  lines · 96% explained · 34 lines not explained" (the last part is a link to the Other stop).
  Right of it: "N / 7 stops viewed".

**Stops.** One CSS grid row per stop: `grid-template-columns: minmax(300px,368px) minmax(0,1fr);
gap:40px; padding:30px 0 34px; border-bottom:1px solid #1a1d21`. Left column is `position:sticky;
top:132px` and drops to opacity .72 once the stop is viewed. Each stop has `id="stop-<id>"` (jump target).

Left column, in order:
1. Header row: tier rule (3×15px, radius 2px — high `#e2954c`, medium `#4a5160`, low `#2b2f36`),
   plan number `01 / 7` (11px mono `#6b7078`, letter-spacing .04em), optional `high` badge
   (10px mono `#e2b878` on `#241f14`, border `#4a4230`), state badges (`changed`, `new`, `queued`),
   comment counter (11px mono + 9×8px outlined square), and the **Mark viewed / ✓ Viewed** toggle
   (height 23px; viewed: bg `#16211a`, border `#25422f`, color `#86d9a8`).
2. Title — high 17px/600, others 15.5px/600; low and Other in `#b9bec7`, the rest `#f0f1f4`.
3. Paragraph — 13px/1.62 `#a9aeb7`, 2–4 sentences, formula "what changed → what follows".
4. Optional "why this stop changed" block (second-pass view): bg `#191712`, left border
   `2px solid #6b5b39`, label 11px mono `#8a7550`, body 12.5px `#d8c9ad`.
5. Bridge sentence — 12.5px italic `#6b7078`.
6. File chips — one per file: height ~29px, bg `#131417`, border `1px solid #262a30`, radius 7px,
   11.5px mono name + 10.5px mono path + `+N` `#6cc38f` / `−M` `#dd8a84` + **read-state box**
   (11px, radius 3px: unread = border `#33383f`; **partial** = border `#3f7a5a` +
   `linear-gradient(90deg,#2b7a55 0 50%,transparent 50%)`; read = solid `#2b7a55` with a ✓ in
   `#0d0e10`; `title` explains each). Clicking a chip scrolls to that stop's diff (see Interactions).

Right column: one card per hunk, border `1px solid #24272d`, radius 9px, bg `#0f1012`.
- Card header: bg `#141518`, bottom border `1px solid #1e2126`, padding 9px 13px — file name 11.5px
  mono `#e9eaee`, path 10.5px mono `#5e636b`, `+N/−M`, entity header 10.5px mono `#6b7078`
  ("apply_edit · 142–164", "new file · class EditPolicy"), then **Expand context** and the per-file
  **Mark viewed** checkbox (11px box: unchecked border `#3a3f47`; checked bg `#2b7a55`, border `#3f7a5a`, ✓).
- Collapsed-context row: "↕ 21 unchanged lines", 11px mono `#5e636b`, bg `#111214`.
- Diff rows (unified): `display:grid; grid-template-columns:46px 46px 16px minmax(0,1fr)`, line-height
  20px, 12px mono. Old/new gutters 10.5px mono right-aligned (ctx `#43474e`, add `#4f7f66`, del `#7f5a56`).
  Add row bg `rgba(66,160,110,.11)` with `+` `#6cc38f`, del row bg `rgba(224,108,102,.10)` with `−`
  `#dd8a84`, code `#cfd3da` (del `#d5c0be`), `white-space:pre; overflow-x:auto`.
- Diff rows (side by side): `grid-template-columns:46px 14px minmax(0,1fr) 46px 14px minmax(0,1fr)`;
  old on the left, new on the right, del/add runs paired, empty side `#0c0d0f`, code cells
  `overflow-x:auto`. **One-sided files (only additions or only deletions) fall back to full-width
  unified in this mode** so half the card is not wasted.
- Selected range: bg `rgba(127,140,255,.13)` + `box-shadow:inset 2px 0 0 #7f8cff` — identical in
  both modes.
- Syntax highlighting is intentionally minimal: keywords `#9aa6ff`, strings/numbers `#d3b183`,
  comments `#5f646d` italic, decorators `#d99a5c`.

### 2. Stop kinds

- **Regular stop** — paragraph + hunks (stops 01–03, 05, 06).
- **Behavioural test digest** (stop 04) — test code hidden by default; the card lists assertions.
  Header: "Behavioral digest · 12 assertions" + note "test code hidden — assertions are the
  contract" + **Show test code / Hide test code** (reveals a real test hunk under the digest).
  Each row: category chip + assertion in human language + anchor link (11px mono, e.g.
  `test_edit_policy:41`). Categories: `new` `#86d9a8`/`#132019`, `changed` `#e2b878`/`#241f14`,
  `weakened` `#e2b878` (this is the first-class signal), `uncovered` `#d99a95`/`#3d2a2c` in a
  footer row on `#151316` — "changed behaviour with no assertion — verify by hand". An assertion
  without an anchor to an existing test is dropped by the validator.
- **Low-importance stop** (05, 06) — collapsed by default: dashed card (`1px dashed #2b2f36`,
  bg `#121316`), text "Collapsed · 76 lines in 3 files · low importance" and, right-aligned,
  "nothing is hidden — click to expand". Expansion is contextual — there is no global expand button.
- **Other · not placed by the model** (stop 07) — the synthetic catch-all. Card border is the
  hatched gradient; copy: "The model did not place these ranges. They are **not explained**, not
  **unimportant** — read them as raw diff." Actions: "Open the 34 lines", "Ask the agent to place them".

### 3. Comment threads (inside hunk cards)

Rows appended under the diff, top border `1px solid #1e2126`. Person threads bg `#141518`
opacity 1; bot threads bg `#121316` opacity .72 with a source chip ("AI review · bot", 10px mono,
border `#2f333a`); resolved threads bg `#101113` opacity .72 with a `resolved` status chip.
Author row: 18px avatar (bots get `border-radius:4px`), name 12px/500, meta 10.5px mono
(`order_service.py:148 · 2h ago`), status/reply toggle on the right.

**Replies support arbitrary nesting.** The reply tree is flattened for rendering: each reply carries
a depth; indent = `min(depth−1,3)×15px` plus a 12px padding and a `1px solid #22252b` left rule.
Beyond depth 4 the indent stops growing and a `↳ replying to <author>` hint (9.5px mono `#5e636b`)
is shown instead, so the code column never gets squeezed. The reply count on the toggle counts the
whole tree ("4 replies ›"). A reviewer's own unpublished reply carries a `draft · publishes on ship`
chip (`#e2b878` on `#241f14`).

### 4. Agent chat (third column, opened explicitly)

`position:sticky; top:46px; width:392px; height:calc(100vh - 46px)`, left border `1px solid #22252b`,
bg `#101113`. Header: "Agent" + "claude-code · sonnet-5" + "Notes 3" + close. When the agent is busy,
a queue banner (bg `#141520`, 12px `#aeb6ff`): "Generating the route · your question is next in the
queue". Messages: author 11.5px/600 (you `#c7cad1`, agent `#aeb6ff`), body 12.5px/1.65 `#c2c7d0`;
a question asked from a selection shows an anchor chip (`↳ order_service.py:148–151 · stop 02`), and
the answer shows "◆ Pinned as a note at order_service.py:148–151". Composer: context chips
(`context: PR 4821`, `order_service.py:148–151`) + input + ⏎ hint.

**AI note at the code** (the other half of the same mechanic): inside the hunk card, bg `#131424`,
top border `1px solid #262a45`, 11px accent diamond. Title "Agent note · asked from lines 148–151",
provenance "model answer · not published to the review host", body 12.5px `#c9cdf0`, actions "Open in chat",
"Turn into a comment draft", "Collapse". Notes are never published to the review backend.

**Selection popover** — appears immediately below the selected rows (never at the end of the card):
bg `#1b1e24`, border `1px solid #333842`, radius 8px, shadow `0 8px 24px rgba(0,0,0,.5)`;
"4 lines selected" + primary **Ask the agent** (`#7f8cff`, ink `#101223`) + "Comment" + "Copy link".

### 5. Terminal actions (floating, always reachable)

`position:fixed; bottom:22px; left:50%; transform:translateX(-50%)`, bg `#181a1e`, border
`1px solid #303540`, radius 11px, shadow `0 16px 44px rgba(0,0,0,.6)`, padding 8px 9px, gap 8px:
progress "2 / 7 stops", divider, unpublished counter (6px `#e2954c` dot + "2 drafts will publish"
in `#e2b878`), divider, "Comment on the PR", "Request changes" (`#d99a95`), and the **ship split
button**: primary `#7f8cff` with the 15px thumbs-up icon + "Ship" (radius 7px 0 0 7px) and a caret
half that opens a 330px menu with two options, each with an explanation —
**Ship** ("Approves this snapshot only. A new push clears it and asks you again.") and
**Sticky ship** ("Approval carries to the next pushes until a file in your CODEOWNERS zone changes.").

### 6. Overview — PR card, phase A: reading the diff (`gen:'generating', genPhase:'reading'`)

The first 10–30 seconds, before the route skeleton exists. Two columns
(`minmax(0,1fr) 356px`, gap 22px). Left: streaming **Summary** card (provenance "claude-code ·
sonnet-5 · 9f3c1ab", a blinking 2px caret `#7f8cff`) and **Files by ownership** — header
"CODEOWNERS · 12 of 18 files · 570 of 862 lines are yours" plus the `My zone 12 / All 18` segmented
control; one row per zone with path, owner chip (yours `#86d9a8`/`#132019`; other `#9ba1ab`;
generated `#6b7078`), "N files · N lines", `+N/−M` and a one-line note.

Right rail, top card (bg `#131424`, border `1px solid #262a45`): spinner + **"Reading the diff,
planning the route"** + "~40s". **No counter and no segment bar** — the number of stops is not known
yet. Three progress lines ("Reading all 18 files of the diff" active, "Deciding how many stops there
are and in what order", "Filling the stops in, one by one"), then the honest note "The plan comes
first — until it is ready there is no stop count to show. The diff is already open below; nothing
waits on the agent." CTA "Open the route skeleton" + hint "placeholders now, stops as they land".
Below: Discussion card and Snapshots card.

### 7. Overview — PR card, phase B: plan ready, filling (`genPhase:'filling'`)

Same card, now with "Filling the route in" + "3 of 7 ready", the 7-segment bar (lit segments are
**not** left-to-right: 01, 02, 05 solid `#7f8cff`, 06 a shimmering gradient, the rest `#2a2e4a`),
the note "The plan is fixed — stops are validated independently, so they light up out of order",
and the **full plan list**: all seven stop titles with per-item state — ready `#dfe2ff` + ✓,
filling `#aeb6ff` + shimmering "filling", queued `#5c6288` + "queued". CTA "Open the route" +
"3 stops are readable already, 4 are placeholders".

### 8. Route — partially filled (`view:'route', gen:'generating', genPhase:'filling'`)

The route holds **all seven plan slots in plan order**. Ready stops are complete; queued stops show
their plan-fixed number and title (dimmed `#6b7078`), a dashed `queued` badge, the line "Title is
fixed by the plan. The agent has not filled this stop in yet — it will land here, in this slot.",
and a shimmering skeleton card in the right column. A banner above says "Filling the route in ·
3 of 7 stops ready · stops land out of order" with a link "Read the full diff meanwhile →".
In the reading phase the same view shows three unnumbered placeholders (`— / ?`).

### 9. Route — second pass, "what changed since your last pass" (`stale:true, routeFilter:'new'`)

Stale banner (bg `#191712`, border `1px solid #3d3524`): "Route was built for 9f3c1ab, the PR is now
on a71d4e2 — 2 new commits; stops 02, 03 and 07 are affected." Second line: "Your progress carried
over: 4 of 7 stops stayed identical and are still marked viewed. Comments on changed ranges are
pinned to the old commit." Actions: **What changed since your last pass** (`#e2954c`, ink `#1b1508`)
and "Regenerate". Applying it filters the route to changed/new stops (numbers stay plan-fixed:
02 / 7, 03 / 7, 07 / 7) and shows a dismissible chip "Showing changes since your last pass ✕".

### 10. Full diff (`view:'diff'`)

Left panel 290px, sticky, bg `#101113`, right border `1px solid #22252b`: filter input, the file
filter chips, then a **file tree** — directory rows (`⌄`/`›` 10px mono `#5e636b`, label 11.5px mono
`#9ba1ab`/500, collapsible) and file rows indented by `8 + depth×13` px. Each file row carries the
read-state box (unread / partial / read, `title` gives "24 of 60 lines seen"), an optional `pci` tag
(9px mono `#c9a464`, border `#3d3a2c`), the route-stop badge (`01`…`07`) or a hatched `not placed`
badge, and `+N`. Foreign roots (`front/checkout`) are dimmed to `#8a8f98`, generated (`gen`) to
`#5e636b`. Footer note: "Hatched marks mean the range has no route stop. 34 lines in 3 files."

Right side: header "Full diff" + "Classic reader. The route no longer sets the order — it stays in
the margin." + the quiet diff-mode toggle + "ignore whitespace". Cards are the same diff component
as the route, with a margin badge per file: "explained in 02 · cache dropped after the write" or a
hatched "no route stop"; unexplained ranges get a hatched footer strip "no route stop covers lines
18–26" + "Ask the agent to place it". File-level **Expand context** and **Mark viewed** behave and
share state with the route.

### 11. Agent disconnected (`gen:'offline'`)

Neutral banner (bg `#151619`, border `1px solid #2b2f36`, grey dot): "Agent disconnected. The reader
works fully — diff, search, comments, ship. AI zones are read-only." + a copyable command
`claude /sherpa review 4821` (11.5px mono in a `#0e0f11` box, `white-space:nowrap`) + "run it in any
harness — the session becomes the worker again" + "Copy command". The chat panel is unavailable;
previously generated snapshots stay readable.

### 12. Generation failed (`gen:'failed'`)

Red-tinted card (bg `#171315`, border `1px solid #3d2a2c`): reason in one sentence
("Generation failed on validation: 2 stops referenced domain/order_state.py, which is not in this
diff."), actions "Retry" and "Open raw output", then the **raw validator output** in a mono block
(bg `#0e0f11`, border `#24272d`, 11px `#8a8f98`, `white-space:pre-wrap`) listing dropped stops and
unresolved anchors with the hint "fix the anchors in the raw snapshot and re-validate without
re-running the model". Footer: "The reader below is unaffected — the full diff is available and the
previous snapshot 9f3c1ab is still readable."

### 13. Review complete (`view:'done'`)

Centered 620px card. Header: 22px `#1f3d2c` circle with ✓ `#86d9a8` + "Shipped · PR 4821" (or
"Sticky ship · PR 4821"), provenance on the right ("ship · 9f3c1ab" / "sticky ship · carries to the
next pushes · 9f3c1ab"). First row: "2 comments published as one batch" + "delivered to the PR"
(`#6cc38f`). Then one row per counter, value 11.5px mono `#c7cad1`:
Stops viewed "7 of 7 · Other read as raw diff" · Diff you actually saw "100% of 862 lines" ·
Of that, read outside the route "34 lines the model did not place" · Comments published
"2 · 1 replying to ai-review-bot" · Signed off on snapshot "9f3c1ab · PR head 9f3c1ab · sonnet-5".
Amber footer: "1 thread from morgan is still open — it does not block the ship, but it stays on
your list." + "Open thread". Single action "Back to the route" (there is no "next review" — v1 opens
one PR per session).

### 14. Command palette (⌘K)

Overlay `rgba(7,8,9,.66)` + `blur(3px)`, panel 560px, bg `#141518`, border `1px solid #313640`,
radius 12px, shadow `0 24px 64px rgba(0,0,0,.65)`, opens 96px from the top. Query row + `esc` hint;
rows are grouped by a 10px mono group label (`go to`, `search`, `route`, `review`, `sherpa`) with the
command label and a key hint. Included commands prove the model: jump to a stop, jump to a file,
search inside the diff, switch preset, regenerate for a commit, ship (publishes N drafts), and
"Report a problem with Sherpa · attaches PR, snapshot, screen".

### 15. Review inbox — NOT IN V1

Kept in the mockups only. The screen opens with a dashed `NOT IN V1` plaque: "In v1 the UI opens for
one PR — the one you ran the skill on. This list is kept in the mockups as a later idea." Below it,
grouped lists ("Needs your review", "You are reviewing") sorted by proximity to production, each row
with a tier dot, PR number, title, route status ("route ready · 7 stops", "building · 2 / 6",
"stale · 2 commits behind"), size and time-to-prod.

### 16. Onboarding tour — first run (`tour: 0…7`) — **the only open build item**

Eight coach-mark cards anchored to real elements of the route screen. Implementation spec:
`SPEC-onboarding-2026-09-02.md` (read it before building — it carries the final copy, the placement
algorithm, the state table and the acceptance checklist). **No dimming, no takeover**:
the page stays scrollable and clickable, so the tour follows the same rule as the rest of the product
(a document, not a wizard). Full storyboard with final copy: `Sherpa Onboarding.dc.html`.

**Card** — width 350px, padding 14/16/15, radius 12px, bg `#171a1f`, border `1px solid #313640`,
shadow `0 20px 52px rgba(0,0,0,.62)`; 9×9px beak rotated 45° with two borders, positioned from the
target's centre (clamped 14px inside the card corners) so it keeps pointing at the highlighted
element even when the card is clamped against the viewport edge. Content: counter `04 / 08` (10px mono `#8f9bff`) + kicker "HOW SHERPA WORKS" (9.5px mono
`#5e636b`); title 14px/600 `#f0f1f4` (≤2 lines); body 12.5px/1.6 `#a9aeb7` (2–3 lines, ≤~200 chars);
footer — "Skip tour" text link on the left (12px `#6b7078`, dashed underline), then "Back"
(ghost, h28) and the primary "Next" (`#7f8cff`, ink `#101223`, h28); the last step's primary reads
**Start reviewing**. No progress dots, no lists or links inside the card.

**Highlight ring** — the target rect + 5px padding: `1.5px solid #7f8cff`, radius 11px,
`box-shadow: 0 0 0 3px rgba(127,140,255,.13), 0 0 26px rgba(127,140,255,.16)`, `pointer-events:none`,
z-index 88 (card 89, above the sticky bars and the floating action bar; the palette sits above both).
Height is clamped to `min(target, viewport − 24px)` so a tall target does not produce an off-screen ring.

**Placement** — below the target by default (needs 214px = card + 14px gap), else above, else right
(used for tall targets: the diff column, the agent panel), else left; horizontal position clamped to
16px from the viewport edge. Recomputed on every scroll and resize (rAF-throttled).

**Steps** (anchor → what it explains): 1 first stop's narrative column → route order; 2 first low-tier
fold → tiers and "nothing hidden silently"; 3 first stop's diff column → the real diff inside a stop;
4 "N / 7 stops viewed" counter → two-level progress; 5 Triage/Full tour toggle → two orders, one state;
6 agent panel → ask from a selection, notes pinned at the code; 7 "Full diff" tab → the classic reader
fallback; 8 floating action bar → drafts publish as a batch, the human decides.

**Rules.**
- Trigger: first entry into the UI, **after the first stop is filled** (never over the skeleton).
  Generation failure → do not start the tour at all.
- Shown once per user (not per PR). The flag is set both on completion and on "Skip tour".
- An unfinished tour resumes at the step the reviewer left it on (step index is persisted next to the flag).
- Steps never change the reviewer's state except step 6, which opens the agent panel and closes it
  again on the next step. The tour does not switch presets, views or expand folds.
- Agent disconnected → step 6 is dropped and the counter becomes `/ 07`.
- Target missing (filter hid it): ring hides, card moves to bottom-centre, the step still reads.
- "Skip tour" is the only permanent dismissal. Clicking the UI does not close the tour; Esc closes the
  palette but not the tour.
- Return path: palette command "Replay the onboarding tour · 8 steps" (group `sherpa`) — resets the
  flag and starts at 01.
- Keyboard: → / Enter next, ← back. Card is `role="dialog"` with `aria-modal="false"`; step changes
  announced in a live region; scroll and card movement disabled under `prefers-reduced-motion`.
- Telemetry: `tour_shown`, `tour_step` (index, dwell), `tour_skipped` (index), `tour_completed`,
  `tour_replayed`.

---

## Filters (one global model)

A single file-filter drives the route, the tree and the full diff:

| id | label | count |
|---|---|---|
| `all` | All files | 18 |
| `mine` | My files · CODEOWNERS | 12 |
| `pci` | PCI DSS files | 3 |
| `generated` | Generated files | 3 |

The toolbar control is a select (button + 250px dropdown, active row bg `#1f2228`, accent ✓
`#8f9bff`); the full-diff sidebar shows the same options as chips. **The list must be
extensible** — new filters are expected. The `PCI DSS · 3 files` chip in the PR header is a shortcut
into the `pci` filter; while it is active an amber banner explains the audit scope ("Showing only
the 3 files inside audit scope — 95 of 862 changed lines. Everything else is hidden, not gone." plus
the file list from CODEOWNERS and "Changes here need an audit sign-off before the ship counts.").
When a filter hides stops, the route simply shows fewer stops — numbers stay plan-fixed.

## Interactions & behaviour

- **Scroll document, not a wizard.** No next/prev. Anchors + jumps only.
- **File chip → diff.** Clicking a file chip animates the scroll (~320ms, ease-in-out cubic, offset
  −150px from the target's top) and flashes a 2px `#7f8cff` accent line at the top of that stop's
  diff column for ~900ms. Do **not** use `scrollIntoView`; set `scrollingElement.scrollTop`.
- **Two-level progress.** Position ("03 / 07") and actual viewedness (stop toggles and per-file
  checkboxes). Viewed stops fade to .72 and their content collapses, so progress is legible as code
  density. Progress is per-user, stored locally (it does not exist in the review backend).
- **Read state per file has three values** — unread / partial / read. Partial means the route showed
  only some ranges of that file; it must be computed from the ranges actually rendered on screen,
  not from a file-level flag.
- **Comment lifecycle (two-step).** Creating or replying saves a draft to the review backend
  immediately; the accumulated batch publishes on ship / request-changes. The floating bar always
  shows "N drafts will publish".
- **Comment filters are additive** and default to people-only; bots and resolved threads are dimmed
  when shown.
- **Diff mode is global** and persists across views; one-sided files render full-width even in
  side-by-side.
- **Agent queue is honest.** One AI task at a time: while the route generates, a chat question shows
  "your question is next in the queue".
- **Keyboard.** ⌘K/Ctrl-K opens the palette, Esc closes it. Full keyboard control and a shortcut for
  every action in the palette are v1 requirements (the prototype only wires these two).
- **Virtualisation** is required for large diffs (not in the prototype).

## State model (what the implementation needs)

Per session (UI): `view` (overview|route|diff|done), `preset` (triage|tour), `routeFilter`
(all|new), `diffMode` (unified|split), `fileFilter` (all|mine|pci|generated), `chatOpen`,
`paletteOpen`, `threadsShow` {people,bots,resolved}, `dirClosed` {path→bool}, `showTestCode`,
`repliesOpen`, `shipMode` (ship|sticky).

Per PR, persisted locally: `viewed` {stopId→bool}, `fileViewed` {fileId→bool}, per-file seen ranges
(for partial read state), route snapshots, chat history, agent notes.

Server / agent side: route snapshot `{content hash, commit, time, provenance {harness, model}}`;
progressive generation (skeleton = ordered list of stop titles + anchors, then per-stop fill);
fail-closed validation (drop stops whose anchors do not resolve, roll uncovered ranges into the
synthetic "Other" stop, drop assertions without a test anchor); task queue with one AI task at a
time; comments read reactively from the review backend.

Route stop shape used by the UI: `{ id, planIndex, tier: high|medium|low|other, title,
paragraph, bridge?, files: [{name, path, added, removed, readState}], anchors: [{file, from, to}],
displayDirectives (what to collapse), commentCount, tests?: [{kind: new|changed|weakened|uncovered,
text, anchor}], unexplained?: true }`.

## Design tokens

**Surfaces** — app `#0d0e10`; panels `#101113`, `#121316`; diff card `#0f1012`; card header
`#141518`; inputs/chips `#15171b`, `#131417`, `#161819`; raised (menus, floating bar) `#181a1e`,
`#1b1e24`; selected row `#1f2228`.

**Borders** — hairline `#1a1d21`, `#1e2126`, `#191c20`; standard `#22252b`, `#24272d`, `#262a30`;
strong `#2b2f36`, `#2f333a`; raised `#303540`, `#313640`, `#333842` (dashed = prototype/meta).

**Text** — primary `#f0f1f4` / `#e9eaee`; secondary `#c7cad1`, `#b9bec7`; body `#a9aeb7`;
muted `#9ba1ab`, `#8a8f98`; dim `#6b7078`, `#5e636b`; gutter `#43474e`.

**Accent (interactive)** — `#7f8cff`; link/hover `#8f9bff` → `#b3bcff`; on-accent ink `#101223`;
accent text on dark `#aeb6ff`, `#c9cdf0`, `#dfe2ff`; accent surfaces `#131424`, `#141520`,
border `#262a45`; selection `rgba(127,140,255,.13)`, text selection `rgba(127,140,255,.28)`.

**Attention (high tier, stale, drafts, audit)** — `#e2954c`; text `#e2b878`, `#c9a464`, `#e6d7bd`;
surface `#241f14`, `#191712`; border `#4a4230`, `#3d3524`, `#6b5b39`.

**Diff / status** — add bg `rgba(66,160,110,.11)`, text `#6cc38f`/`#86d9a8`, gutter `#4f7f66`;
del bg `rgba(224,108,102,.10)`, text `#dd8a84`/`#e8a29c`, gutter `#7f5a56`; read/viewed fill
`#2b7a55` with border `#3f7a5a`; error `#e0736c`, `#d99a95`, surface `#171315`, border `#3d2a2c`.

**Neutral tier fills** — medium `#4a5160`, low `#2b2f36`, unfilled `#2a2e4a`.

**"Not explained" hatch** — `repeating-linear-gradient(115deg,#33373e 0 3px,#1b1e22 3px 6px)`
(sidebar variant `#2a2e34 / #1b1e22`, footer strip `#191c20 / #141518`).

**Type** — IBM Plex Sans 400/450/500/600 for UI, IBM Plex Mono 400/500 for code, paths, numbers,
commits, keys and all machine data. Scale: 22px/600 PR title · 19px/600 screen title · 17px/600
high-tier stop title · 15.5px/600 stop title · 15px/600 section title · 13.5px input · 13px/1.62 body ·
12.5px UI text · 12px secondary · 11.5px controls and mono file names · 11px mono meta · 10.5px mono
gutters and paths · 10px badges · 9.5px prototype/scope labels. Code: 12px mono, line-height 20px.

**Radius** — 2–3px (rules, tier marks) · 4–5px (badges, small chips) · 6px (buttons, rows) ·
7px (inputs, chips, primary buttons) · 8–9px (cards, popovers) · 10–12px (panels, dialogs).

**Spacing** — 30px page gutter · 40px column gap · 22px card gap · 14px control gap · 8–10px inner
gap · 26/30/34px vertical rhythm between stops.

**Shadows** — popover `0 8px 24px rgba(0,0,0,.5)` · menu `0 16px 40px rgba(0,0,0,.6)` ·
floating bar `0 16px 44px rgba(0,0,0,.6)` · dialog `0 24px 64px rgba(0,0,0,.65)`.

**Motion** — spinner `spin .8s linear infinite` · skeleton/streaming `shimmer 1.6s ease-in-out
infinite` (0.35 → 0.8 → 0.35 opacity) · caret `caret 1s step-end infinite` · jump scroll ~320ms
ease-in-out cubic · jump flash ~900ms. Nothing else animates; the reader must feel static.

## Assets

- **Fonts**: IBM Plex Sans + IBM Plex Mono (Google Fonts). Swap for the codebase's own sans/mono if
  it has them — keep the sans/mono split and the mono-for-machine-data rule.
- **Thumbs-up icon** on the ship button: 16×16 `fill="currentColor"` SVG supplied by the team
  (already inlined in the prototype). Use the design-system icon set for it and for the small
  glyphs (⌄ › ⇄ ↕ ↳ ✓ ✕), which the prototype renders as text characters.
- **Product mark**: a rotated 15px accent square — placeholder, not final branding.
- No imagery anywhere; this UI is text, code and controls only.

## Files

- `SPEC-elements.md` — **element-level spec**: state matrix for every control (hover, active,
  focus, disabled, loading, error), per-component behaviour, data edge cases, loading timings,
  keyboard map, accessibility and the acceptance checklist. Read it together with this document:
  the README defines *what* each screen is, SPEC-elements defines *how every part behaves*.
- `Sherpa.dc.html` — the clickable prototype (all 13 states + the onboarding tour; `SCENARIOS` menu
  switches between them).
- `SPEC-onboarding-2026-09-02.md` — **onboarding handoff spec** (the current build item): card and
  ring anatomy, the eight steps with final copy and anchors, placement algorithm, states, show-once
  and resume model, degradation, keyboard/a11y, telemetry, open questions, acceptance checklist.
- `Sherpa Onboarding.dc.html` — onboarding storyboard: the eight steps with final copy and per-step
  anchor/state/placement rationale, card and ring anatomy, show-once and degradation rules.
- `../product.md` — the product brief the design was built from (problem, principles, v1 scope,
  non-scope, cross-cutting scenarios F1–F5, required system states).

## Open questions for the team

1. Partial read state needs a definition of "seen": rendered on screen, or scrolled past with a dwell
   threshold? The UI shows it either way, but the number must be defensible.
2. The route currently hides stops when a file filter is active. Alternative: keep all stops and dim
   the ones without matching files. Worth testing on a 60+ file PR.
3. Keyboard model is only sketched (⌘K/Esc). v1 requires full coverage plus a shortcut for every
   palette command.
4. Deep reply chains beyond depth 4 fall back to a "replying to" hint — verify against real threads
   in the review backend.
