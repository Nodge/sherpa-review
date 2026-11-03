# Handoff: Sherpa — AI-assisted code review (route over the diff)

> **The `*.dc.html` prototypes are a reference, not a source of code.** They load React and fonts from the internet (unpkg, Google Fonts) and won't open in an isolated environment. To serve them locally, run `python3 -m http.server` in this directory. Do not implement the prototype's SCENARIOS button and Contrast slider.
>
> **2026-08-26 addition.** Context bridges, the icon set, the PR comments modal, the composer (including line comments) and the Discussion card are described in `SPEC-additions-2026-08-26.md`. The working mockup is `Sherpa Additions.dc.html`. It also clarifies §Assets (an icon set instead of font symbols) and §3 (publishing drafts as one batch on Ship). The context bridge is already implemented in `Sherpa.dc.html`.
>
> **2026-09-02 addition: onboarding.** The onboarding tour has 8 tips over the live UI. The spec is `SPEC-onboarding-2026-09-02.md` (step text, anatomy, positioning algorithm, states, display flags, reduced functionality, a11y, acceptance checklist). The storyboard with 1:1 cards is `Sherpa Onboarding.dc.html`. The reference implementation is in `Sherpa.dc.html`: the "07 · First run" scenario in the SCENARIOS dock and the "Replay the onboarding tour" palette command.
>
> **2026-09-12 addition: light theme, settings menu, contrast, typography, responsive width.** The spec is `SPEC-theming-2026-09-12.md`: theme model and a full colour table for both themes, a rebuilt dark palette, settings menu replacing the avatar, a rem font scale with an 11px minimum, fluid width and code panel width limits by diff mode. The numbered sections below describe that design pass. The working implementation is `Sherpa.dc.html`.

> **2026-09-20 addition: customer-requested changes and controls.** The spec is `SPEC-changes-2026-09-20.md`. It adds an "Open issue" switch above the composer editor. Stop descriptions support paragraphs, lists, links and inline code within the validator's budget. Code threads collapse entirely into a marker on the card's left edge, with a ○ Resolve / ✓ Resolved button and Reply/Edit/Delete below the text. The "Comments from" filter is removed. The PR comments modal has width `clamp(620px, 68vw, 1120px)` and contains threads. Basic controls share one state rule (hover = background up one step, pressed = another step). The combined page is `Sherpa Changes 2026-09-20.dc.html`. The reference for (2), (3) is `Sherpa.dc.html`, stop 02. It overrides §3 (threads), 1c/1d of the 08-26 spec and the SPEC-elements state matrix wherever they differ. Departures accepted during implementation are in `../decisions.md`, the "Threads, issues and composer" section.

> **2026-09-26 addition (clarified 2026-10-10): extra visual styles.** The Theme setting selects Auto · Dark · Light. The UI build can include extra styles (`packages/ui/src/styles/extra/<id>/`). Each adds its own switch to the settings menu and applies its own fonts, density and dark or light palette. Auto follows the system even with a style enabled. With no extra styles, there is no switch. §Design tokens below points to the current values. `theme.md` explains the design decisions, and an extra style is described in the README in its directory.

## Overview

Sherpa is an internal code-review UI. An AI agent running in the reviewer's own agent harness (Claude Code, Codex, …) prepares a **route** through a pull request: an ordered set of stops that covers the whole diff, from the heart of the change to its consequences and glue. The UI itself is a full replacement for the current review tool: a diff reader with two-way comments and ship. The reviewer walks the route, reads only what matters, and decides faster without losing control over what they are signing off.

Product principles that shape the UI (do not design them away during implementation):

1. **The reader is complete without AI.** Diff, search, comments, ship must work when the route is missing, stale, or the agent is dead. The AI layer degrades independently.
2. **The route sets reading order, it does not retell the code.** Every stop shows the real diff in real diff components.
3. **AI prioritises attention, never silently hides code.** Everything collapsed stays visible as a collapsed block with a counter. A validator guarantees coverage of the diff structurally, and the UI explicitly marks ranges left without explanation.
4. **Importance ≠ size.** A 6-line CODEOWNERS change can outrank a 200-line refactor.
5. **One viewer, two orders.** Route and full diff share one state (viewed marks, comments, notes).
6. **Canonical state lives in the review backend**: the UI saves a comment draft immediately and publishes the accumulated batch on ship / request-changes.
7. **The human decides.** Nothing is posted or shipped without an explicit action, and every AI artefact shows its provenance (harness, model, commit).

## About the design files

`Sherpa.dc.html` in this bundle is a **design reference created in HTML**: a clickable prototype that shows intended look and behaviour. It is not production code to copy. The task is to **recreate these screens in the target codebase's environment** (React/TS in the existing app, its router, its data layer) using established patterns there. Where this document gives exact hex, px and copy values, match them. Where it describes behaviour, implement it with the codebase's own primitives (virtualised lists, keyboard-shortcut registry, etc.).

The prototype has a **prototype-only affordance** that must NOT be implemented: the dashed `SCENARIOS` button in the top bar and its dropdown. It exists to jump between mocked states during demos. Everything else is product UI.

## Fidelity

**High-fidelity.** The prototype has final colours, typography, spacing, density, copy and interaction behaviour. Layout is designed for a desktop window ≥1440px wide (the prototype sets `min-width: 1440px`). There is no mobile layout in v1.

---

## Screens / views

The app is one PR-scoped workspace. Top-level views are tabs: **Overview · Route · Full diff**. The prototype covers 13 states. The sections below list each one with the state that produces it.

### 0. Top bar (all views)

The bar is sticky: height 46px, background `#0d0e10`, bottom border `1px solid #333741`, horizontal padding 14px, gap 14px.

| Element | Spec |
|---|---|
| Product mark | 15×15px `#7f8cff` square, `border-radius:3px`, `transform:rotate(45deg)`, opacity .9 |
| Wordmark | "Sherpa", 13.5px/600, `#ffffff`, letter-spacing −.01em; version "0.4.1" 11px mono `#e7f1ff` |
| Breadcrumb | `quillmart/quillmart` / `PR 4821`, 12px mono, `#ffffff`, separator `#7b8390` |
| View tabs | Segmented control: container `#1d2020`, border `1px solid #363b44`, radius 8px, padding 3px; each button height 24px, padding 0 10px, radius 6px; active `background:#434954; color:#ffffff; font-weight:500` (light theme: a white pill `#ffffff`/`#000000` with shadow `0 1px 2px rgba(20,24,32,.18), 0 0 0 1px rgba(20,24,32,.08)`); inactive `transparent / #ffffff` |
| Agent status | Ghost button, height 28px, border `1px solid #363b44`, radius 7px. 6px status dot: connected `#6cc38f`, working `#e2954c`, failed `#e0736c`, disconnected `#e7f1ff`. Label: "Agent · claude-code" / "Agent working · 1 in queue" / "Agent disconnected". Click toggles the chat panel. |
| Search | Ghost button "Search" + ⌘K key hint (11px mono, border `1px solid #434954`, radius 4px). Opens the command palette. |
| Feedback | Ghost button "Feedback". Opens the report-a-problem form (free text, optional category, auto-attached context: Sherpa version, PR, snapshot, active screen; context shown before sending). |
| Settings | 28×28 icon button, sliders icon 15px, border `1px solid #363b44`, radius 7px; open: bg `#262b34`, border `#4a515c`. Opens the settings menu (252px panel under the trigger): Theme Auto · Dark · Light, a separate switch per extra style of the build (none in a build without extra styles; see `theme.md`), Language, Text size M · L, Replay onboarding, Commands ⌘K, per `SPEC-theming-2026-09-12.md` §7. There is no avatar or account: the skill runs locally. |

### 1. Route — triage (the main screen; `view:'route', preset:'triage', gen:'ready'`)

The screen has two columns in one scrollable document. It is **not a stepper**: there is no next/prev and no takeover.

**PR header** (padding 26px clamp(30px, 2.4vw, 60px) 0): meta line 11.5px mono: `+806` `#86d9a8`, `−56` `#e8a29c`, "18 files", branch, then the **PCI DSS filter chip** (see Filters). Title 22px/600, letter-spacing −.015em, line-height 1.25, `text-wrap:pretty`. Author row 13px `#ffffff` with an 18px avatar: the person's photo when the host provides one (e.g. the GitHub avatar), initials otherwise or when the photo fails to load. On the right, a snapshot selector: height 30px, `#1d2020`, border `1px solid #363b44`, radius 7px, 11.5px mono label `snapshot 9f3c1ab · current` (or `· stale`).

**Sticky toolbar** (top:46px, z-index 30, background `rgba(13,14,16,.92)`, `backdrop-filter:blur(8px)`, bottom border `1px solid #2c3038`, padding 10px clamp(30px, 2.4vw, 60px) 11px):

- Preset segmented control **Triage | Full tour** + hint text 12.5px `#e7f1ff` ("Most important first — stop whenever you have seen enough." / "Reading order: entry point → definitions → consequences → verification.")
- Diff-mode toggle, deliberately quiet: borderless mono button, 11.5px `#dae4f3`, `⇄ unified` / `⇄ side by side`, hover `#ffffff`. The mode is global and applies to every file in every view.
- File filter select (see Filters).
- Divider 1×18px `#3a3f48`, label "Comments from" 12.5px `#e7f1ff`, then three additive toggle chips `People 3` `Bots 2` `Resolved 1`: height 24px, radius 6px. On: border `#3f4880`, bg `#1e2240`, color `#c3caff` (indigo in both themes). Off: border `#333741`, transparent, `#e7f1ff`. Default: people on, bots and resolved off.
- **Coverage strip** (second row): 7px tall, radius 4px, track `#212429`, 1px gaps. Segments are proportional to changed lines and carry `title` tooltips: high `#e2954c` 21.8%, medium `#7b87a0` 40.4%, low `#434954` 33.9%, **not explained** 3.9% rendered as `repeating-linear-gradient(115deg,#515863 0 3px,#262b30 3px 6px)`. Legend 11.5px mono: "862 changed lines · 96% explained · 34 lines not explained" (the last part is a link to the Other stop). Right of it: "N / 7 stops viewed".

**Stops.** One CSS grid row per stop: `grid-template-columns: clamp(300px, 26%, 500px) minmax(0,1fr); gap:clamp(40px, 3vw, 72px); padding:30px 0 34px; border-bottom:1px solid #24292f`. The route has no max-width. `--diff-max` caps the diff column (1280px unified, 1920px side by side), and the column stays left-aligned. The left column is `position:sticky; top:132px`. Once the stop is viewed, it keeps full opacity, and the title and paragraph step down to the muted text roles (`SPEC-theming-2026-09-12.md` §4: in the dark theme the steps coincide, in the light theme they differ). Each stop has `id="stop-<id>"` (jump target).

The left column contains, in order:
1. Header row: tier rule (3×15px, radius 2px: high `#e2954c`, medium `#7b87a0`, low `#434954`), plan number `01 / 7` (11.5px mono `#e7f1ff`, letter-spacing .04em), optional `high` badge (11px mono `#e2b878` on `#241f14`, border `#4a4230`), state badges (`changed`, `new`, `queued`), comment counter (11.5px mono + 9×8px outlined square), and the **Mark viewed / ✓ Viewed** toggle, height 23px. A viewed toggle has bg `#1d3022`, border `#25422f`, color `#86d9a8`. Hover on either state is green: bg `#25422f`, border `#3a8f66`.
2. Title: high 17px/600, others 15.5px/600. Low and Other use `#ffffff`, the rest `#ffffff`.
3. Paragraph: 13.5px/1.62 `#ffffff`, 2–4 sentences, formula "what changed → what follows".
4. Optional "why this stop changed" block (second-pass view): bg `#231e14`, left border `2px solid #6b5b39`, label 11.5px mono `#9c8760`, body 13px `#d8c9ad`.
5. Bridge sentence: 13px italic `#e7f1ff`.
6. File chips, one per file: height ~29px, bg `#18191d`, border `1px solid #3a404a`, radius 7px, 12px mono name + 11px mono path + `+N` `#6cc38f` / `−M` `#dd8a84` + **read-state box** (11px, radius 3px). The box is unread = border `#515a65`, **partial** = border `#3f7a5a` + `linear-gradient(90deg,#3a8f66 0 50%,transparent 50%)`, or read = solid `#3a8f66` with a ✓ in `#0d0e10`, and its `title` explains each state. A read file keeps full opacity, and the check is its only read marker. Clicking a chip scrolls to that stop's diff (see Interactions).

The right column has one card per hunk: border `1px solid #363b44`, radius 9px, bg `#111214`.
- Card header: bg `#1a1b1e`, bottom border `1px solid #2c3038`, padding 9px 13px. It holds the file name 12px mono `#ffffff`, path 11px mono `#dae4f3`, `+N/−M`, then, pushed to the right, **Expand context** and the per-file **Mark viewed** checkbox (11px box, unchecked: border `#5e6673`, checked: bg `#3a8f66`, border `#3f7a5a`, ✓).
- Collapsed-context row: "↕ 21 unchanged lines", 11.5px mono `#dae4f3`, bg `#1a1b1e` (the card-header surface: the §2 value `#141517` merged with the card).
- Diff rows (unified): `display:grid; grid-template-columns:<old gutter> <new gutter> 16px minmax(0,1fr)`, line-height 20px, 12px mono. Gutter width follows the longest line number shown in the card (at least 2 digits, one width per card and for every gutter): digits × `0.6em` of the gutter font + 33px. The 33px split into 8px on one side of the number and 25px on the other: on the right for the comment ✎ button (the new side in unified, each half in side by side), on the left for the thread marker hanging over the card edge (the old side in unified). Old/new gutters 11px mono right-aligned (ctx `#6e7580`, add `#5f9478`, del `#a0736e`). Add row bg `rgba(66,160,110,.11)` with `+` `#6cc38f`, del row bg `rgba(224,108,102,.10)` with `−` `#dd8a84`, code `#ffffff` (del `#d5c0be`), `white-space:pre; overflow-x:auto`.
- Diff rows (side by side): `grid-template-columns:<gutter> 14px minmax(0,1fr) <gutter> 14px minmax(0,1fr)`, a `1px solid #2c3038` divider opens the right half. Old lines go on the left and new on the right, del/add runs are paired, the empty side is `#0b0c0e`, and code cells use `overflow-x:auto`. **One-sided files (only additions or only deletions) fall back to full-width unified in this mode** so half the card is not wasted.
- Selected range: bg `rgba(127,140,255,.13)` + `box-shadow:inset 2px 0 0 #7f8cff`, identical in both modes.
- Syntax highlighting is intentionally minimal: keywords `#9aa6ff`, strings/numbers `#d3b183`, comments `#8a919c` italic (a deliberate step off the §2 ladder: `#dae4f3` was indistinguishable from the code), decorators `#d99a5c`.

### 2. Stop kinds

- **Regular stop**: paragraph + hunks (stops 01–03, 05, 06).
- **Behavioural test digest** (stop 04): the card hides test code by default and lists assertions. Header: "Behavioral digest · 12 assertions" + note "test code hidden — assertions are the contract" + **Show test code / Hide test code** (reveals a real test hunk under the digest). Each row: category chip + assertion in human language + anchor link (11.5px mono, e.g. `test_edit_policy:41`). Categories: `new` `#86d9a8`/`#182e20`, `changed` `#e2b878`/`#241f14`, `weakened` `#e2b878` (this is the first-class signal), `uncovered` `#d99a95`/`#3d2a2c` in a footer row on `#1b171b` with the copy "changed behaviour with no assertion — verify by hand". The validator drops an assertion without an anchor to an existing test.
- **Low-importance stop** (05, 06) is collapsed by default: dashed card (`1px dashed #434954`, bg `#16171b`), text "Collapsed · 76 lines in 3 files · low importance" and, right-aligned, "nothing is hidden — click to expand". Expansion is contextual, and there is no global expand button.
- **Other · not placed by the model** (stop 07) is the synthetic catch-all. Its card border is the hatched gradient. Copy: "The model did not place these ranges. They are **not explained**, not **unimportant** — read them as raw diff." Actions: "Open the 34 lines" (transparent, border `#7b8390`, text `#ffffff`/500, hover bg `#262b34`, border `#dae4f3`) and "Ask the agent to place them".

### 3. Comment threads (inside hunk cards)

Thread rows sit under the diff, top border `1px solid #2c3038`. Person threads: bg `#1a1b1e`, opacity 1. Bot threads: bg `#16171b`, opacity .72, with a source chip ("ai-review · bot", 11px mono, border `#4a515c`). Resolved threads: bg `#121315`, opacity .72, with a `resolved` status chip. Author row: 18px round avatar, bots included (the photo when the host provides one, initials otherwise), name 12.5px/500, meta 11px mono (`order_service.py:148 · 2h ago`), status/reply toggle on the right.

**Replies support arbitrary nesting.** The UI flattens the reply tree for rendering, and each reply carries a depth. Indent = `min(depth−1,3)×15px` plus a 12px padding and a `1px solid #333741` left rule. Beyond depth 4 the indent stops growing and a `↳ replying to <author>` hint (11px mono `#dae4f3`) appears instead, so the code column never gets squeezed. The reply count on the toggle counts the whole tree ("4 replies ›"). A reviewer's own unpublished reply carries a `draft · publishes on ship` chip (`#e2b878` on `#241f14`).

### 4. Agent chat (third column, opened explicitly)

`position:sticky; top:46px; width:clamp(392px, 26vw, 560px); height:calc(100vh - 46px)`, left border `1px solid #333741`, bg `#121315`. Header: "Agent" + "claude-code · sonnet-5" + "Notes 3" + close. When the agent is busy, a queue banner (bg `#1a1b2d`, 12.5px `#aeb6ff`): "Generating the route · your question is next in the queue". Messages: author 12px/600 (you `#ffffff`, agent `#aeb6ff`), body 13px/1.65 `#ffffff`. A question asked from a selection shows an anchor chip (`↳ order_service.py:148–151 · stop 02`), and the answer shows "◆ Pinned as a note at order_service.py:148–151". Composer: anchor chip (`order_service.py:148–151`, only when the question has an anchor) + input + two-line hint (Enter — send / Shift+Enter — new line). There is no PR chip, because the whole screen is about one PR.

**AI note at the code** (the other half of the same mechanic): inside the hunk card, bg `#131424`, top border `1px solid #262a45`, 11px accent diamond. Title "Agent note · asked from lines 148–151", provenance "model answer · not published to the PR", body 13px `#c9cdf0`, actions "Open in chat", "Turn into a comment draft", "Collapse". Sherpa never publishes notes to the review backend.

**Selection popover**: it appears immediately below the selected rows (never at the end of the card): bg `#262b34`, border `1px solid #515a6a`, radius 8px, shadow `0 8px 24px rgba(0,0,0,.5)`. Contents: "4 lines selected" + primary **Ask the agent** (`#7f8cff`, ink `#101223`) + "Comment" + "Copy link".

### 5. Terminal actions (floating, always reachable)

`position:fixed; bottom:22px; left:50%; transform:translateX(-50%); width:max-content; white-space:nowrap`, bg `#212429`, border `1px solid #4c5466`, radius 11px, shadow `0 16px 44px rgba(0,0,0,.6)`, padding 8px 9px, gap 8px: progress "2 / 7 stops", divider, unpublished counter (6px `#e2954c` dot + "2 drafts will publish" in `#e2b878`), divider, "Comment on the PR", "Request changes" (`#d99a95`), and the **ship split button**: primary `#7f8cff` with the 15px thumbs-up icon + "Ship" (radius 7px 0 0 7px) and a caret half that opens a 330px menu with three options, each with an explanation: **Ship** ("Approves this snapshot only. A new push clears it and asks you again.") and **Sticky ship** ("Approval carries to the next pushes until a file in your CODEOWNERS zone changes.").

The menu has a third row, **Comment** ("Publishes N drafts without a verdict", or "Hands N drafts to the agent" on the local host): the drafts go out, nothing is approved or blocked. The primary part publishes the mode last chosen in the menu, with its label ("Ship", "Sticky ship", "Comment"). The bar draws only the modes the host accepts on this PR. When Comment is the only one (own PR on GitHub, local review), "Request changes" is gone and the split is a single primary "Comment · N" without the caret.

### 6. Overview — PR card, phase A: reading the diff (`gen:'generating', genPhase:'reading'`)

This state covers the first 10–30 seconds, before the route skeleton exists. Content max-width is 1700px, in two columns (`minmax(0,1fr) 356px`, gap 22px). Left: streaming **Summary** card (provenance "claude-code · sonnet-5 · 9f3c1ab", a blinking 2px caret `#7f8cff`) and **Files by ownership**, with the header "CODEOWNERS · 12 of 18 files · 570 of 862 lines are yours" plus the `My zone 12 / All 18` segmented control. Each zone gets one row with path, owner chip (yours `#86d9a8`/`#182e20`, other `#ffffff`, generated `#e7f1ff`), "N files · N lines", `+N/−M` and a one-line note.

Right rail, top card (bg `#131424`, border `1px solid #262a45`): spinner + **"Reading the diff, planning the route"** + "~40s". **No counter and no segment bar**: the number of stops is not known yet. Three progress lines ("Reading all 18 files of the diff" active, "Deciding how many stops there are and in what order", "Filling the stops in, one by one"), then the honest note "The plan comes first — until it is ready there is no stop count to show. The diff is already open below; nothing waits on the agent." CTA "Open the route skeleton" + hint "placeholders now, stops as they land". Below it sit the Discussion card and the Snapshots card.

### 7. Overview — PR card, phase B: plan ready, filling (`genPhase:'filling'`)

The same card now shows "Filling the route in" + "3 of 7 ready", the 7-segment bar (lit segments are **not** left-to-right: 01, 02, 05 solid `#7f8cff`, 06 a shimmering gradient, the rest `#2a2e4a`), the note "The plan is fixed — stops are validated independently, so they light up out of order", and the **full plan list**: all seven stop titles with per-item state: ready `#dfe2ff` + ✓, filling `#aeb6ff` + shimmering "filling", queued `#7d83ad` + "queued". CTA "Open the route" + "3 stops are readable already, 4 are placeholders".

### 8. Route — partially filled (`view:'route', gen:'generating', genPhase:'filling'`)

The route holds **all seven plan slots in plan order**. Ready stops are complete. Queued stops show their plan-fixed number and title (dimmed `#e7f1ff`), a dashed `queued` badge, the line "Title is fixed by the plan. The agent has not filled this stop in yet — it will land here, in this slot.", and a shimmering skeleton card in the right column. A banner above says "Filling the route in · 3 of 7 stops ready · stops land out of order" with a link "Read the full diff meanwhile →". In the reading phase the same view shows three unnumbered placeholders (`— / ?`).

### 9. Route — second pass, "what changed since your last pass" (`stale:true, routeFilter:'new'`)

Stale banner (bg `#231e14`, border `1px solid #3d3524`): "Route was built for 9f3c1ab, the PR is now on a71d4e2 — 2 new commits; stops 02, 03 and 07 are affected." Second line: "Your progress carried over: 4 of 7 stops stayed identical and are still marked viewed. Comments on changed ranges are pinned to the old commit." Actions: **What changed since your last pass** (`#e2954c`, ink `#1b1508`) and "Regenerate". The first action filters the route to changed/new stops (numbers stay plan-fixed: 02 / 7, 03 / 7, 07 / 7) and shows a dismissible chip "Showing changes since your last pass ✕".

### 10. Full diff (`view:'diff'`)

Left panel `clamp(320px, 22vw, 560px)`, sticky, bg `#121315`, right border `1px solid #333741`, padding 12px 10px: filter input, the file filter chips, then a **file tree**. Chains of single-child directories collapse into one row (`domain/policies`, like VS Code compact folders), and a click folds the whole chain. Directory rows (`⌄`/`›` 11px mono `#dae4f3`, label 12px mono `#ffffff`/500) and file rows alike indent by `26 + depth×10` px, and the left 26px hold the route-stop label. For siblings, a directory's chevron and a file's read-state box start in one column. A collapsed chain counts as one level, so its children sit exactly one step deeper. Row order: chevron (directories only, files keep no slot for it) · stop label `01`…`07` (absolute, left 3px, 17×13, radius 3, 10px mono `#7b8390`, border `#2c3038`, `title` "explained in stop 02") or a hatched 17×13 `not placed` slot without text (`title` "no route stop covers this file") · read-state box 10×10 (unread / partial / read) · file name (`flex:1`, ellipsis at the end) · optional audit-scope tag, e.g. `pci` (11px mono `#c9a464`, border `#3d3a2c` from token `--tag-audit-border`, with the tag text from the host's audit lens) · `+N` right-aligned in a 30px column. Row `title`: `<path> · N of M changed lines seen`. This deviates from `SPEC-theming-2026-09-12.md` §6a (`<name> · …`), and `docs/decisions.md` records why: the name is already on the row, and the full path has nowhere else to live since it left the label. The tree dims foreign roots (`front/checkout`) to `#ffffff` and generated ones (`gen`) to `#dae4f3`. A read file, or a directory whose visible files are all read, dims its label to `--tree-read-color` (`#848b97`). This colour wins over the foreign and generated tints. Read dimming skips the active row. Footer note: "Hatched marks mean the range has no route stop. 34 lines in 3 files."

The right side has side paddings `clamp(30px, 2.4vw, 60px)`. `max-width: var(--diff-max)` caps the header row and the cards (1280px unified, 1920px side by side), and both stay left-aligned. It shows the header "Full diff" + "Classic reader. The route no longer sets the order — it stays in the margin." + the quiet diff-mode toggle + "ignore whitespace". Cards are the same diff component as the route, with a margin badge per file: "explained in 02 · cache dropped after the write" or a hatched "no route stop". Unexplained ranges get a hatched footer strip "no route stop covers lines 18–26" + "Ask the agent to place it". File-level **Expand context** and **Mark viewed** behave and share state with the route.

### 11. Agent disconnected (`gen:'offline'`)

Neutral banner (bg `#1b1c20`, border `1px solid #434954`, grey dot): "Agent disconnected. The reader works fully — diff, search, comments, ship. AI zones are read-only." + a copyable command `claude /sherpa review 4821` (12px mono in a `#0f1012` box, `white-space:nowrap`) + "run it in any harness — the session becomes the worker again" + "Copy command". The chat panel is unavailable. Previously generated snapshots stay readable.

### 12. Generation failed (`gen:'failed'`)

Red-tinted card (bg `#1f1719`, border `1px solid #3d2a2c`): reason in one sentence ("Generation failed on validation: 2 stops referenced domain/order_state.py, which is not in this diff."), actions "Retry" and "Open raw output", then the **raw validator output** in a mono block (bg `#0f1012`, border `#363b44`, 11.5px `#ffffff`, `white-space:pre-wrap`) listing dropped stops and unresolved anchors with the hint "fix the anchors in the raw snapshot and re-validate without re-running the model". Footer: "The reader below is unaffected — the full diff is available and the previous snapshot 9f3c1ab is still readable."

### 13. Review complete (`view:'done'`)

The screen is a centered 620px card. Header: 22px `#1f3d2c` circle with ✓ `#86d9a8` + "Shipped · PR 4821" (or "Sticky ship · PR 4821"), provenance on the right ("ship · 9f3c1ab" / "sticky ship · carries to the next pushes · 9f3c1ab"). First row: "2 comments published as one batch" + "delivered to the PR" (`#6cc38f`). Then one row per counter, value 12px mono `#ffffff`: Stops viewed "7 of 7 · Other read as raw diff" · Diff you actually saw "100% of 862 lines" · Of that, read outside the route "34 lines the model did not place" · Comments published "2 · 1 replying to review-bot" · Signed off on snapshot "9f3c1ab · PR head 9f3c1ab · sonnet-5". Amber footer: "1 thread from morgan is still open — it does not block the ship, but it stays on your list." + "Open thread". Single action "Back to the route" (there is no "next review", because v1 opens one PR per session).

After Publish without a verdict nothing was approved or blocked, so the card says only what happened: header "Comments published · PR 4821", provenance "comment · 9f3c1ab", the snapshot row reads "Snapshot reviewed" instead of "Signed off on snapshot", and the amber footer drops the ship clause ("2 threads are still open"). The ship clause stays only after Ship and Sticky ship.

### 14. Command palette (⌘K)

Overlay `rgba(7,8,9,.66)` + `blur(3px)`, panel 560px, bg `#1a1b1e`, border `1px solid #4e5666`, radius 12px, shadow `0 24px 64px rgba(0,0,0,.65)`, opens 96px from the top. The panel has a query row + `esc` hint. An 11px mono group label (`go to`, `search`, `route`, `review`, `sherpa`) groups the rows, and each row has the command label and a key hint. Included commands prove the model: jump to a stop, jump to a file, search inside the diff, switch preset, regenerate for a commit, ship (publishes N drafts), and "Report a problem with Sherpa · attaches PR, snapshot, screen".

### 15. Review inbox — NOT IN V1

This screen exists in the mockups only. It opens with a dashed `NOT IN V1` plaque: "In v1 the UI opens for one PR — the one you ran the skill on. This list is kept in the mockups as a later idea." Below it, grouped lists ("Needs your review", "You are reviewing") sorted by proximity to production, each row with a tier dot, PR number, title, route status ("route ready · 7 stops", "building · 2 / 6", "stale · 2 commits behind"), size and time-to-prod.

### 16. Onboarding tour — first run (`tour: 0…7`)

Eight coach-mark cards anchored to real elements of the route screen. Implementation spec: `SPEC-onboarding-2026-09-02.md` (read it before building, because it carries the final copy, the placement algorithm, the state table and the acceptance checklist). **No dimming, no takeover**: the page stays scrollable and clickable, so the tour follows the same rule as the rest of the product (a document, not a wizard). Full storyboard with final copy: `Sherpa Onboarding.dc.html`.

**Card**: width 350px, padding 14/16/15, radius 12px, bg `#1f242b`, border `1px solid #4e5666`, shadow `0 20px 52px rgba(0,0,0,.62)`. The 9×9px beak (rotated 45°, two borders) takes its position from the target's centre (clamped 14px inside the card corners), so it keeps pointing at the highlighted element even when the card is clamped against the viewport edge. Content: counter `04 / 08` (11px mono `#8f9bff`) + kicker "HOW SHERPA WORKS" (11px mono `#dae4f3`), title 14px/600 `#ffffff` (≤2 lines), body 13px/1.6 `#ffffff` (2–3 lines, ≤~200 chars). Footer: "Skip tour" text link on the left (12.5px `#e7f1ff`, dashed underline), then "Back" (ghost, h28) and the primary "Next" (`#7f8cff`, ink `#101223`, h28). The last step's primary reads **Start reviewing**. The card has no progress dots, lists or links.

**Highlight ring**: the target rect + 5px padding, drawn as `1.5px solid #7f8cff`, radius 11px, `box-shadow: 0 0 0 3px rgba(127,140,255,.13), 0 0 26px rgba(127,140,255,.16)`, `pointer-events:none`, z-index 88 (card 89). Ring and card sit above the sticky bars and the floating action bar, and the palette sits above both. The ring clamps its height to `min(target, viewport − 24px)` so a tall target does not produce an off-screen ring.

**Placement**: below the target by default (needs 214px = card + 14px gap), else above, else right (used for tall targets: the diff column, the agent panel), else left. The horizontal position is clamped to 16px from the viewport edge. The card recomputes its placement on every scroll and resize (rAF-throttled).

**Steps**:

| Step | Anchor | What it explains |
|---|---|---|
| 1 | first stop's narrative column | route order |
| 2 | first low-tier fold | tiers and "nothing hidden silently" |
| 3 | first stop's diff column | the real diff inside a stop |
| 4 | "N / 7 stops viewed" counter | two-level progress |
| 5 | Triage/Full tour toggle | two orders, one state |
| 6 | agent panel | ask from a selection, notes pinned at the code |
| 7 | "Full diff" tab | the classic reader fallback |
| 8 | floating action bar | drafts publish as a batch, the human decides |

**Rules.**
- Trigger: first entry into the UI, **after the first stop is filled** (never over the skeleton). On generation failure, do not start the tour at all.
- The tour shows once per user (not per PR). Sherpa sets the flag both on completion and on "Skip tour".
- An unfinished tour resumes at the step the reviewer left it on (the step index persists next to the flag).
- Steps never change the reviewer's state except step 6, which opens the agent panel and closes it again on the next step. The tour does not switch presets, views or expand folds.
- When the agent is disconnected, the tour drops step 6 and the counter becomes `/ 07`.
- When the target is missing (a filter hid it), the ring hides, the card moves to bottom-centre, and the step still reads.
- "Skip tour" is the only permanent dismissal. Clicking the UI does not close the tour. Esc closes the palette but not the tour.
- Return path: the palette command "Replay the onboarding tour · 8 steps" (group `sherpa`) resets the flag and starts at 01.
- Keyboard: → / Enter next, ← back. The card is `role="dialog"` with `aria-modal="false"`. A live region announces step changes. Under `prefers-reduced-motion`, the tour disables scroll and card movement.
- Telemetry: `tour_shown`, `tour_step` (index, dwell), `tour_skipped` (index), `tour_completed`, `tour_replayed`.

---

## Filters (one global model)

A single file-filter drives the route, the tree and the full diff:

| id | label | count |
|---|---|---|
| `all` | All files | 18 |
| `mine` | My files · CODEOWNERS | 12 |
| `pci` | PCI DSS files | 3 |
| `generated` | Generated files | 3 |

The toolbar control is a select (button + 250px dropdown, active row bg `#2d323b`, accent ✓ `#8f9bff`). The full-diff sidebar shows the same options as chips. **The list must be extensible**, because new filters are expected. The `PCI DSS · 3 files` chip in the PR header is a shortcut into the audit filter. The audit filter covers any lens the host marks as an audit scope (`Lens.audit`), with PCI DSS as the example, and the UI never recognizes it by id. While it is active an amber banner explains the audit scope ("Showing only the 3 files inside audit scope — 95 of 862 changed lines. Everything else is hidden, not gone." plus the list of files in the audit lens and "Changes here need an auditor sign-off."). When a filter hides stops, the route simply shows fewer stops, and their numbers stay plan-fixed.

## Interactions & behaviour

- **Scroll document, not a wizard.** There is no next/prev, only anchors and jumps.
- **File chip → diff.** Clicking a file chip animates the scroll (~320ms, ease-in-out cubic, offset −150px from the target's top) and flashes a 2px `#7f8cff` accent line at the top of that stop's diff column for ~900ms. Do **not** use `scrollIntoView`. Set `scrollingElement.scrollTop` instead.
- **Two-level progress.** Progress has a position ("03 / 07") and actual viewedness (stop toggles and per-file checkboxes). Viewed stops switch to muted text (no opacity) and their content collapses, so progress is legible as code density. Progress is per-user, stored locally (it does not exist in the review backend).
- **Read state per file has three values**: unread / partial / read. Partial means the route showed only some ranges of that file. The UI must compute it from the ranges actually rendered on screen rather than from a file-level flag.
- **Comment lifecycle (two-step).** Creating or replying saves a draft to the review backend immediately, and the accumulated batch publishes on ship / request-changes. The floating bar always shows "N drafts will publish".
- **Comment filters are additive** and default to people-only. When shown, bots and resolved threads appear dimmed.
- **Diff mode is global** and persists across views. One-sided files render full-width even in side-by-side.
- **Agent queue is honest.** One AI task at a time: while the route generates, a chat question shows "your question is next in the queue".
- **Keyboard.** ⌘K/Ctrl-K opens the palette, Esc closes it. Full keyboard control and a shortcut for every action in the palette are v1 requirements (the prototype only wires these two).
- **Virtualisation** is required for large diffs (not in the prototype).

## State model (what the implementation needs)

Per session (UI): `view` (overview|route|diff|done), `preset` (triage|tour), `routeFilter` (all|new), `diffMode` (unified|split), `fileFilter` (all|mine|pci|generated), `chatOpen`, `paletteOpen`, `threadsShow` {people,bots,resolved}, `dirClosed` {path→bool}, `showTestCode`, `repliesOpen`, `shipMode` (ship|sticky|comment).

Per PR, persisted locally: `viewed` {stopId→bool}, `fileViewed` {fileId→bool}, per-file seen ranges (for partial read state), route snapshots, chat history, agent notes.

Server / agent side:

- route snapshot `{content hash, commit, time, provenance {harness, model}}`
- progressive generation (skeleton = ordered list of stop titles + anchors, then per-stop fill)
- fail-closed validation (drop stops whose anchors do not resolve, roll uncovered ranges into the synthetic "Other" stop, drop assertions without a test anchor)
- task queue with one AI task at a time
- comments read reactively from the review backend

Route stop shape used by the UI: `{ id, planIndex, tier: high|medium|low|other, title, paragraph, bridge?, files: [{name, path, added, removed, readState}], anchors: [{file, from, to}], displayDirectives (what to collapse), commentCount, tests?: [{kind: new|changed|weakened|uncovered, text, anchor}], unexplained?: true }`.

## Design tokens

Current colours, font sizes, spacing and motion live in [tokens.css](../../packages/ui/src/styles/tokens.css). Extra styles define their values in their own `styles/extra/<id>/` directories. [theme.md](theme.md) explains the palette and typography decisions. The dated specs preserve the original design proposals.

### Component tokens

Each theme supplies the same token set so a nested gallery card cannot inherit values from the surrounding theme. Components use semantic roles rather than choosing a theme. Review appearance in the gallery beside the prototype, using the same viewport.

## Assets

- **Fonts**: the main style uses IBM Plex Sans + IBM Plex Mono from locally built npm packages. An extra style keeps its fonts in its directory. At runtime, fonts are served from the build.
- **Thumbs-up icon** on the ship button: 16×16 `fill="currentColor"` SVG supplied by the team (already inlined in the prototype). Use the design-system icon set for it and for the small glyphs (⌄ › ⇄ ↕ ↳ ✓ ✕), which the prototype renders as text characters.
- **Product mark**: a rotated 15px accent square. It is a placeholder for the final branding.
- The UI has no imagery anywhere. It is text, code and controls only.

## Files

- `SPEC-changes-2026-09-20.md` covers the **current phase's spec changes**: issue switch, stop description markup, collapsing threads into markers, a wide PR modal with threads, shared control-state rules. It includes contracts, removals, an acceptance checklist and open questions.
- `Sherpa Changes 2026-09-20.dc.html` is the 09-20 iteration overview page: a table of base control states in both themes and interactive mockups 2a–2e.
- `Sherpa Additions.dc.html` is the interactive mockup for the 08-26 additions and 09-20 changes. Section `#t3` (3 thread marker positions, recommending 3a) is a rejected exploration. SPEC-changes §3 accepted the marker on the card's left edge.
- `SPEC-theming-2026-09-12.md` covers the theme phase's spec changes: theme model and tokens, light palette, revised dark palette, settings menu, language, typography in rem, responsive width, acceptance checklist and open questions.
- `theme.md` explains theme boundaries and the reasons behind palette, control-state and typography choices. Current values live in `tokens.css`.
- `SPEC-elements.md` is the **element-level spec**: state matrix for every control (hover, active, focus, disabled, loading, error), per-component behaviour, data edge cases, loading timings, keyboard map, accessibility and the acceptance checklist. Read it together with this document: the README defines *what* each screen is, SPEC-elements defines *how every part behaves*.
- `Sherpa.dc.html` is the clickable prototype (all 13 states + the onboarding tour). Its `SCENARIOS` menu switches between them.
- `SPEC-onboarding-2026-09-02.md` is the **onboarding handoff spec**: card and ring anatomy, the eight steps with final copy and anchors, placement algorithm, states, show-once and resume model, degradation, keyboard/a11y, telemetry, open questions, acceptance checklist.
- `Sherpa Onboarding.dc.html` is the onboarding storyboard: the eight steps with final copy and per-step anchor/state/placement rationale, card and ring anatomy, show-once and degradation rules.
- `../product.md` is the product brief the design was built from (problem, principles, v1 scope, non-scope, cross-cutting scenarios F1–F5, required system states).

## Open questions for the team

1. Partial read state needs a definition of "seen": rendered on screen, or scrolled past with a dwell threshold? The UI shows it either way, but the number must be defensible.
2. The route currently hides stops when a file filter is active. The alternative is to keep all stops and dim the ones without matching files. It is worth testing on a 60+ file PR.
3. The keyboard model is only sketched (⌘K/Esc). v1 requires full coverage plus a shortcut for every palette command.
4. Deep reply chains beyond depth 4 fall back to a "replying to" hint. Verify this against real threads in the review backend.
