# Sherpa — element spec: states, edge cases, a11y

Companion to `README.md`. The README says what each screen is; this document says how every element
behaves in every state, what happens at the edges of the data, and what the implementation must
guarantee. Where the prototype and this document disagree, **this document wins** — the prototype
only demonstrates rest states of most controls.

---

## 1. Global rules

### 1.1 State matrix

Every interactive element must implement all applicable states.

> **Superseded on 2026-09-20 for hover / active / focus-visible** by `SPEC-changes-2026-09-20.md` §5: hover changes the
> surface only (one step up the grey ladder, no text or border change, no transition), press is one more step, the focus
> ring is `2px solid` opaque accent with `outline-offset: 2px` (−2px inside segments). Links and the trash icon are the only
> exceptions. The rows below stay for rest / selected / disabled / loading / error. Live matrix: gallery card "Controls".

| State | Rule |
|---|---|
| rest | as specified per component |
| hover | surface lightens one step (`transparent` → `#181a1e`, `#161819` → `#1b1e24`, `#22252b` → `#282c33`); dim text lifts one step (`#6b7078` → `#9ba1ab`, `#9ba1ab` → `#c7cad1`); borders lift `#24272d` → `#2f333a`. 90ms ease-out, colour only — never size, never position |
| active (press) | one step darker than rest, no transition |
| focus-visible | `box-shadow: 0 0 0 2px rgba(127,140,255,.55)`, offset 1px, radius follows the element. Keyboard only — never on mouse click |
| selected / on | as specified (usually `#22252b` + `#e0e2e7`); must be distinguishable from hover without colour alone — pair with a ✓, a filled box, or a weight change |
| disabled | opacity .45, `cursor:default`, no hover, and a `title` that says **why** |
| loading | label stays, a 10px spinner replaces the leading glyph; the element keeps its width (no layout shift) |
| error | border `#3d2a2c`, text `#d99a95`, message below in 12px |

### 1.2 Cross-cutting

- **Accent is for interaction only.** `#7f8cff` never marks state or severity, only "you can act here"
  and "this is the AI layer". Amber `#e2954c` marks attention (high tier, stale, unpublished drafts,
  audit scope). Green `#2b7a55`/`#6cc38f` is only "read / published". Red is only failure.
- **No colour-only signalling** anywhere: tier has size + rule + optional badge; read state has a box
  shape; unexplained ranges have a hatch pattern.
- **Truncation.** Paths truncate from the left (`…/api/v3/handlers.py`), file names never truncate
  before the extension, stop titles wrap to at most 3 lines then ellipsis, code never truncates —
  it scrolls horizontally per row.
- **Tooltips.** 400ms delay, plain `title`-equivalent, 12px, max 320px, never carry information
  that exists nowhere else except for read-state and coverage details.
- **Optimistic UI.** Viewed marks, collapses, filters and comment drafts apply instantly; a failed
  write reverts the control and shows an inline error with "Retry". Never a modal.
- **Nothing blocks on the agent.** Every AI-dependent surface has a non-AI state and the diff stays
  interactive while any AI task runs.
- **Reduced motion.** With `prefers-reduced-motion`, spinners become a static 3-dot indicator,
  shimmer becomes a flat `#1a1d21` block, the jump animation becomes an instant jump, the caret stops
  blinking. The flash after a jump remains (it is information), but static for 900ms.
- **Density.** Line-height 20px for code and 1.5–1.62 for prose is fixed; no compact/comfortable
  toggle in v1.

---

## 2. Component spec

### 2.1 View tabs (Overview · Route · Full diff)

- Rest / hover / active per §1.1. Selected: `#2b2f36`, `#f0f1f4`, weight 500.
- Keyboard: `1`/`2`/`3` jump to the tabs; `←`/`→` move between them when focused.
- The last visited tab is remembered per PR. Exception: a deep link to a comment always opens the
  view where the comment lives (full diff or the stop that covers it).
- Route tab when no route exists: label stays enabled, and the view shows the "no route yet" state
  (§4.4) — never a disabled tab.
- ARIA: `role="tablist"` / `role="tab"` / `aria-selected`.

### 2.2 Agent status pill

| Agent state | Dot | Label | Click |
|---|---|---|---|
| connected, idle | `#6cc38f` | Agent · claude-code | opens chat |
| working | `#e2954c` | Agent working · N in queue | opens chat, scrolled to the queue banner |
| failed last task | `#e0736c` | Agent · last task failed | opens chat with the error and "Retry" |
| disconnected | `#6b7078` | Agent disconnected | opens the reconnect popover with the copyable command |

- Hover shows harness, model, session uptime and queue length.
- The dot never pulses; queue progress lives in the banner, not in the top bar.
- Transition to disconnected must be announced once via a polite live region, not a toast storm.

### 2.3 Command palette

- Opens with ⌘K/Ctrl-K from anywhere, including inside the chat input (the input must not swallow it).
- Rest row transparent; **hover and keyboard cursor share one style** (`#1b1e24`) and there is only
  ever one cursor — mouse move moves it.
- ↑/↓ move, ⏎ runs, Esc closes and restores focus to the trigger, Tab is trapped inside.
- Query semantics: fuzzy over stop titles, file paths, commands; a query starting with `/` searches
  the diff contents, `:` jumps to a line, `@` filters to a person's threads.
- Empty query: recent + suggested commands. **No results**: "Nothing matches "cachee"" + "Search the
  diff contents instead" as an actionable row. Never an empty panel.
- Destructive-ish commands (Ship, Request changes, Regenerate) carry their consequence in the row
  ("publishes 2 drafts") and are never a single blind ⏎ away without that text.
- ARIA: `role="dialog" aria-modal`, the list is a `listbox`, results announced as "N commands".

### 2.4 Coverage strip

- Segments are proportional to changed lines; each has a tooltip "high · stops 01–02 · 188 lines".
- Hover a segment: it brightens one step and the matching stops get a 2px accent rule in the margin.
  Click scrolls to the first stop of that tier. The hatched segment scrolls to the Other stop.
- Minimum segment width 3px so a 6-line unexplained range stays clickable; if a tier is 0 lines its
  segment is omitted, not rendered as a hairline.
- The legend numbers are computed, never hardcoded: `changed = added + removed`,
  `explained = changed − unplaced`, percentage rounded down (95.6% → "95%", never "96%").
- Loading (route generating): the strip shows one flat `#181a1e` track with a shimmering accent
  segment sized to the ready stops, and the legend reads "coverage known after the plan".
- 100% explained: the hatched segment disappears and the legend drops the third clause — it must not
  say "0 lines not explained".

### 2.5 Preset switch (Triage / Full tour)

- Switching keeps scroll anchored on the stop currently at the top of the viewport (same stop id
  stays in view), never resets to the top.
- Switching never changes viewed marks, comments or filters.
- Disabled while no route exists, with `title` "available once the route is built".

### 2.6 Diff-mode toggle (quiet)

- Rest `#5e636b`, hover `#9ba1ab`, focus ring as §1.1. Label always states the **current** mode.
- Global and persisted per user (not per PR). Applies to route, full diff and test-code hunks.
- One-sided files (adds only / deletes only) ignore split and render full-width; their header gets a
  `title` "shown full width — this file is only additions".
- Below 1100px of available diff width, split is unavailable: the control disables with `title`
  "not enough width for side by side" and the view falls back to unified.

### 2.7 File filter select

- Button shows label + count; dropdown rows carry a ✓ for the active one.
- Opens on click and on ↓; ↑/↓ move, ⏎ selects, Esc closes, click-outside closes, focus returns.
- Counts are live. **Zero-result filters must still be selectable** and the result explains itself:
  "No files in PCI DSS scope in this PR" + "Show all files".
- Selecting a filter that hides the stop you were reading keeps that stop visible with a note
  "kept in view — outside the current filter" until the next scroll. Nothing the reviewer is looking
  at may vanish under the cursor.
- The URL carries the filter so a shared link reproduces the view.

### 2.8 Comment source chips (People / Bots / Resolved) — removed

- Dropped on 2026-09-21 (SPEC-changes-2026-09-20 §6a): a thread at the code is a marker on the card
  edge, and hiding a group of threads no longer pays for a filter of its own. The author lens
  (click a participant — "only morgan's threads") stays.

### 2.9 Stop card

- **Rest / viewed.** Viewed switches the left column to the muted text roles (title and paragraph one step down, no opacity — `SPEC-theming-2026-09-12.md` §4) and collapses hunks to a summary
  row "3 files · 76 lines · viewed" that re-expands on click. Un-marking restores the previous
  expansion, not a full expansion.
- **Hover on the card** does nothing (the card is not a button). Hover on its header row reveals the
  secondary actions (copy link to stop, "Ask the agent about this stop", 👍/👎 on generation quality)
  which are `opacity:0` at rest and `opacity:1` on hover **and** on keyboard focus within the card.
- **Focus.** The stop is a landmark: `role="region"` with `aria-label="Stop 02 of 7 — …"`.
- **Long content.** Paragraph over 4 sentences is clamped to 4 with "more"; a stop with more than 12
  files shows the first 8 chips + "8 more files" expander; a stop with more than 20 hunks lazy-renders
  beyond the first 5.
- **Stop with zero hunks** (rare, e.g. everything in it is already collapsed as generated): the right
  column shows the dashed collapsed card, never blank space.
- **Tier badge** is optional (a tweak): with badges off, tier must remain readable from the rule
  colour + title size + the low collapse.
- **Anchor drift.** If a stop's anchors no longer resolve (base changed under the reviewer), the card
  turns into an amber notice: "This stop pointed at lines that are no longer in the diff. Regenerate
  or read the file raw." — never silently empty.

### 2.10 Mark viewed (stop level and file level)

- Two-state checkbox: unchecked box `#3a3f47`; checked `#2b7a55`/`#3f7a5a` with a ✓ and label "Viewed".
- Hover: border lifts, box fills to 25% accent-green. Press: instant fill.
- Optimistic; a failed write reverts with an inline "not saved · retry".
- Marking a stop viewed marks its files viewed **only if the stop covers every changed line of those
  files**; otherwise those files go to `partial`. Unmarking a stop never unmarks a file that was
  marked from elsewhere.
- Inside a stop, a file card's toggle marks only the lines that card shows — the file goes to
  `partial` everywhere else until every changed line is covered. The card's toggle, read box and
  collapse follow the coverage of its own lines. Marking every card of a stop marks the stop.
- Keyboard: `v` toggles the focused stop or file.
- `aria-pressed` on the toggle, and the change is announced ("Stop 02 marked viewed, 3 of 7").

### 2.11 File chip (narrative column)

- Hover: bg `#181a1e`, border `#2f333a`, and the target hunk in the right column gets a 2px accent
  rule (a two-way link preview). Press: bg `#15171b`.
- Click: animated scroll (~320ms) with a −150px offset and a 900ms flash. If the file's hunk is
  inside a collapsed low stop or a viewed collapsed stop, it expands first, then scrolls.
- Read box: three states per §2.12. The whole chip stays one line; path truncates from the left.
- Deleted file: name gets a strikethrough and `−N` only. Renamed: "old → new" with the old part in
  `#6b7078`. Binary: `+N/−M` replaced by "binary".
- Right-click / ⌘-click offers "Open in editor" (the external-editor requirement) and "Copy path".

### 2.12 Read state (3 values, everywhere a file appears)

| Value | Visual | Meaning |
|---|---|---|
| unread | empty box, border `#33383f` | no changed line of this file has been on screen |
| partial | half-filled box (`linear-gradient(90deg,#2b7a55 0 50%,transparent 50%)`), border `#3f7a5a` | some ranges seen — typical when the route showed only part of a file |
| read | solid `#2b7a55` + ✓ | every changed line has been on screen, or the reviewer marked it |

- Tooltip always gives the numbers: "24 of 60 changed lines seen".
- Manual "Mark viewed" forces `read` and pins it (later scrolling can never downgrade it).
- Generated files start at `read` with the tooltip "generated — marked read by default"; the reviewer
  can un-pin them.
- The definition of "seen" is a product decision (open question 1 in the README) — the UI needs one
  number and the tooltip must match it exactly.

### 2.13 Hunk card header

- Buttons: **Expand context** (adds 20 lines above/below per click, then "Expand all"; disabled at
  file boundaries with `title` "start of file"), **Mark viewed**, and on hover: "Copy link",
  "Open in editor", "Blame".
- The header is sticky inside a tall card so the file name stays visible while scrolling the hunk.
- The header carries no hunk entity label: the name of the enclosing function/class cannot be
  extracted reliably from the `@@` header or by regex, so the card doesn't guess.
- A file above 2000 changed lines renders collapsed with "2,412 changed lines — open file" to protect
  scroll performance; the route's own directives can override this for high-tier ranges.

### 2.14 Diff rows

- Hover a row: bg lifts by 4% and a gutter action strip appears (comment ✎, copy link, react) —
  `opacity:0` at rest, and reachable by keyboard (`c` comments the focused line).
- Click-drag or shift-click selects a range; selection persists while scrolling and is cleared by Esc
  or by clicking elsewhere. Selection styling is identical in unified and split (§ README).
- Word-level highlight inside changed pairs: `rgba(66,160,110,.22)` on adds, `rgba(224,108,102,.22)`
  on deletions.
- Very long lines scroll horizontally per row; the two panes of split mode scroll **independently**
  per row, not as one pane.
- Tabs render as 4 spaces with a `title` showing the raw width; trailing whitespace in added lines
  gets a `rgba(224,108,102,.25)` block.
- CRLF-only changes, whitespace-only hunks and mode changes render as one-line notices
  ("whitespace only", "mode 100644 → 100755"), collapsed by default.
- Non-UTF8 or binary content: "binary file not shown" + size delta + "Open in editor".

### 2.15 Selection popover

- Appears within 60px below the last selected row, never further; flips above when the selection is
  at the bottom of the viewport.
- Closes on Esc, on scroll past 200px, or when the selection is cleared. Does not close on hover-out.
- "Ask the agent" is disabled when the agent is disconnected, with `title` "reconnect the agent to
  ask about a selection" — "Comment" and "Copy link" stay enabled (the reader never degrades).
- While a question is in flight, the popover collapses into a chip "asked · answer will land here".
- In Markdown document view (§2.22) the popover anchors to the block that covers the selected source
  lines; the actions are the same.

### 2.16 Agent note (at the code)

- Collapsible; collapsed state is one line: "◆ Agent note · why the cache drop moved · 3 lines".
- Actions: "Open in chat" (scrolls the chat panel to the message), "Turn into a comment draft"
  (creates a draft prefilled with the note text and a "quoted from the agent" prefix — the draft is
  the reviewer's, attribution stays visible), "Collapse", "Delete note".
- Notes are local: they are never sent to the review backend, they survive reload, and they are
  dropped (with a notice) when the range they anchor to disappears — "2 notes lost their anchor after
  the new push · view".
- Multiple notes on overlapping ranges stack, newest first, and collapse into "3 notes here" above 3.

### 2.17 Threads and replies

- Rest: the action row under a message is always there, nothing is hover-only — "Reply" on every
  published comment, "Edit · Delete" on your own (published ones only with `capabilities.editPublished`),
  "Copy link" under the root. Resolve is a toggle in the message header
  (SPEC-changes-2026-09-20 §3, §5).
- Reply composer: 13px input, "saved as a draft" hint under it, ⌘⏎ saves the draft, Esc discards
  with a confirm if non-empty. A draft is saved to the backend within 1s of the last keystroke and
  shows a `draft` chip (text shortened on 2026-09-20; see SPEC-changes-2026-09-20 §4a).
- **Edge cases:** a thread resolved by someone else while you were typing — the composer stays, with
  a notice "resolved by ada while you were writing · your reply will reopen it";
  a thread whose line no longer exists → "outdated" chip and the thread renders under the file header
  instead of a row, with "view at the old commit";
  a thread on a file removed from the diff → collected into a "3 threads on files no longer in this
  PR" group at the bottom of the route;
  a bot thread with 40 replies → at the code every reply is shown, the collapsed marker carries
  the count and one click hides the whole thread (SPEC-changes-2026-09-20 §3).
- Nesting is unbounded (see README §3): at the code replies deeper than one level render flat with
  a "↳ replying to X" hint, so the code column never gets squeezed.
- Resolve/unresolve is optimistic and rolls back on a host error. The way back is the toggle itself —
  the 5s undo affordance is gone (SPEC-changes-2026-09-20 §6a).

### 2.18 Chat panel

- Width `clamp(392px, 26vw, 560px)`; the diff column reflows, it is never overlaid. Below 1280px total width the
  panel becomes an overlay with a scrim.
- States: **empty** ("Ask about the PR or select lines and ask about them" + 3 example prompts),
  **queued** (banner: "Generating the route · your question is next"), **streaming** (token stream
  with a caret; "Stop" button available), **failed** (message with the model's error + "Retry"),
  **disconnected** (composer disabled + reconnect command).
- The composer keeps the selection context chips; removing a chip re-scopes the question to the PR.
- History is per PR, persists across reloads, and is searchable (`@` in the palette).
- Streamed text is announced to screen readers once per message, not per token.

### 2.19 Floating action bar

- Always visible on route and full diff; hides itself while the reviewer is dragging a selection and
  reappears on release.
- Progress and draft counters are live. With 0 drafts the amber cluster is replaced by
  "no unpublished comments" in `#6b7078`.
- **Ship split button.** Primary click ships with the last used mode (default: plain ship); the caret
  opens the two-option menu. Menu rows carry their consequences verbatim (README §5).
- Guardrails: if any stop is unviewed, the ship menu prepends a line "3 stops not viewed — ship
  anyway?" (informational, never blocking — the reviewer decides). If unpublished drafts exist, both
  ship and request-changes state the count they will publish.
- Failure while publishing: the bar turns into an error state "2 comments failed to publish · retry"
  and the review is **not** marked shipped.
- Request changes is styled as a peer, not a destructive action; it publishes the same batch.
- Keyboard: `⌘⏎` opens the ship menu (never ships blind), `⌘⇧⏎` requests changes.

### 2.20 File tree (full diff)

- Rows are 26px tall; hover lifts the bg, the active file gets `#1b1e24`.
- Directories: click toggles; ⌥-click collapses the whole subtree; state persists per PR.
  Directory rows show aggregate `+N/−M` and a read-state summary (all read → ✓, some read → half box).
- Keyboard: ↑/↓ move, →/← expand/collapse, ⏎ opens the file in the diff pane, `/` focuses the filter.
- Filter input: matches path substrings and fuzzy file names; shows "No files match" + "Clear".
- 60+ files: the tree virtualises and directories with more than 20 children collapse by default.
- Single-file PRs: the tree is replaced by the file's outline (symbols) — never a one-row tree.
- ARIA: `role="tree"`, `aria-expanded`, `aria-level`.

### 2.21 Banners (stale / offline / failed / audit scope / not-in-v1)

- One banner slot; if several conditions hold, priority is: generation failed → agent disconnected →
  route stale → audit-scope filter. The others collapse into a single line "+2 notices" that expands.
- Banners are dismissible only when they describe a filter (audit scope, what-changed). Condition
  banners (stale, offline, failed) stay until the condition ends.
- Each banner states the condition, its consequence, and exactly one primary action.

---

### 2.22 Markdown document view

- Files `.md`, `.markdown`, `.mdown` get a toggle among the card header actions. The button names the
  destination ("Markdown" in code view, "Code" in document view); `aria-pressed` reflects document view.
- The mode is per file, kept in the diff store for the session: it survives card unmount (full-diff
  virtualization, route column placeholder) and is not persisted across reloads.
- The document is rendered per contiguous run of source lines; runs separated by a collapsed gap are
  never joined. A partial file shows the notice "Showing available fragments. Expand the full context
  in code view." — context expansion lives in code view only.
- Modified files offer **Before / After**; added files render only "after", deleted only "before".
  Switching the side clears the selection.
- Native mouse selection of up to 4000 characters becomes the same line selection as in code view
  (side + first..last source line) and opens the selection popover (§2.15). Longer selections show a
  status notice and select nothing. Keyboard selection is not supported.
- Threads, agent notes and the composer render once, after the block containing their source line, with
  the same ids as in code view; a block with a selection or a focused thread gets the accent left rule.
- "Ask the agent" shows the quotation as a blockquote above the composer (§2.18) and sends it to the
  agent as `selectedText` together with the line range. The composer itself is not prefilled.
- Same markdown subset as comments (`comment` profile): raw HTML is shown as text, unsafe links are
  plain text.

## 3. Loading, skeletons, timings

| Surface | 0–200ms | until data | on failure |
|---|---|---|---|
| PR shell | nothing (no spinner flash) | header skeleton bars | full-page error with "Retry" and the raw error |
| Diff | nothing | per-file skeleton cards, 3 visible | "Diff failed to load" per card + retry |
| Summary | — | streaming text + caret | "Summary unavailable" (route still usable) |
| Route plan | — | reading-phase card (no counter) | failed card with raw output |
| Stop fill | — | plan slot with shimmering skeleton | per-stop error "this stop failed validation · view raw" |
| Chat answer | typing indicator after 300ms | token stream | error message + retry, question preserved |
| Draft save | — | "saving…" after 500ms | "not saved · retry", text preserved locally |

Rules: no spinner before 200ms; no skeleton that shifts layout when real content lands (skeletons
match the final block height); a task that exceeds 60s shows "still working · N of M" with a cancel.

---

## 4. Data edge cases

### 4.1 PR shape

- **Empty diff / no changed files:** "Nothing to review — this PR has no changes against the base."
  Ship stays available.
- **One file, few lines:** the route is not generated at all (below the threshold); the UI opens on
  the full diff with a note "small PR — no route needed".
- **Huge PR (500+ files, 50k lines):** route generation is capped and says so ("the plan covers the
  120 files with logic changes; 380 generated files are grouped in one stop"); the diff virtualises;
  the coverage strip still accounts for every line.
- **Only generated files:** everything lands in the generated stop; the strip is one low segment.
- **Merge commits / conflicts:** conflicted files render with the "conflict" badge and are excluded
  from route coverage math, with an explicit line in the Other stop.
- **Stacked PRs / base change:** the snapshot selector doubles as base selector; changing base
  invalidates the route (stale banner) and keeps progress for unchanged ranges.
- **Force-push:** old snapshot stays readable, marked "commit no longer in the PR".

### 4.2 Ownership and audit

- Reviewer with **no CODEOWNERS zone:** the filter defaults to All files and "My files" is disabled with
  `title` "no ownership zone for you in this repo".
- **All files yours:** "My files" shows the same count as All and is not preselected.
- **PCI scope files with no changes in this PR:** the audit chip disables with count 0.

### 4.3 Route quality

- **Model returns fewer stops than the plan:** missing slots become "not filled — the agent stopped
  early" with a Regenerate action; coverage math counts them as unexplained.
- **Unplaced lines = 0, or the route is not built yet:** the Other stop does not exist anywhere —
  no card, no slot in stop counters, the Overview plan list, the palette or the tour. While sections
  are still filling, "unplaced" is only the unfilled slots; while the diff is still parsing, the
  count is unknown. A failed section counts as built: its lines honestly land in Other. Conflict
  files keep the stop (§4.1).
- **Unplaced lines > 40% of the diff:** the Other stop is promoted above low-tier stops and the
  banner says "the plan explains less than half of this diff — consider regenerating".
- **Duplicate anchors** (two stops claiming one range): the validator keeps the first, the second
  shows "range moved to stop 02".
- **Assertion without a test anchor:** dropped by the validator; the digest footer counts drops
  ("2 claims dropped — no matching test").

### 4.4 No route / agent lifecycle

- **Never generated:** the Route tab shows an invitation card — "No route for this PR yet. Run the
  skill in your harness to build one" + the command + "Read the full diff".
- **Agent dies mid-generation:** partially filled stops stay readable and are marked
  "filled before the agent stopped"; the rest revert to plan slots; the banner offers reconnect.
- **Agent replaced (new session):** provenance on new stops differs from old ones; the snapshot list
  shows both harnesses. Provenance is per snapshot, never averaged.
- **Two harnesses at once:** not supported in v1 — the second session shows "another session is
  already the worker for this PR".

### 4.5 Comments and publishing

- **Draft written while offline:** stays local with "will be saved when the connection returns";
  the floating bar counts it and warns that ship is unavailable until it saves.
- **Ship with unresolved threads:** allowed; the summary reports them (README §13).
- **Publish partially fails:** ship is not recorded; the bar lists which comments failed.
- **Someone else ships first:** a live notice "ada shipped this PR 20s ago — your comments will
  still publish".
- **Comment on a line that moved:** the draft carries its original commit and shows "pinned to
  9f3c1ab" once the head moves.

---

## 5. Keyboard map (v1 target)

| Keys | Action |
|---|---|
| ⌘K | command palette |
| 1 / 2 / 3 | Overview / Route / Full diff |
| j / k | next / previous stop (route) or file (full diff) |
| n / p | next / previous unviewed range |
| v | toggle viewed on the stop or file under the pointer, or focused |
| c | comment on the line under the pointer, or focused; ⌘⏎ save draft |
| r | reply to the thread under the pointer, or focused |
| e | expand context on the hunk under the pointer, or focused |
| x | toggle collapse of the stop under the pointer, or focused |
| t | switch preset (triage / full tour) |
| d | switch diff mode |
| f | focus the file filter |
| / | search inside the diff |
| a | ask the agent about the selection |
| g then o / r / d | go to Overview / Route / Full diff |
| ⌘⏎ | open the ship menu |
| ⌘⇧⏎ | request changes |
| ? | shortcut cheatsheet |
| Esc | close overlay / clear selection |

The target of a shortcut is the element under the mouse pointer if the mouse moved after the last
focus change; otherwise it is the focused element.

Every shortcut must also exist as a palette command with the same wording, and the cheatsheet is
generated from one registry (no drift between the two).

---

## 6. Accessibility

- Contrast: body `#a9aeb7` on `#0d0e10` ≈ 8.4:1; muted `#8a8f98` ≈ 6.2:1; dim `#6b7078` ≈ 4.1:1 —
  dim is allowed **only** for 11.5px+ mono meta, never for instructions. Accent `#7f8cff` on `#0d0e10`
  ≈ 6.6:1. On-accent ink `#101223` on `#7f8cff` ≈ 7.9:1. Code `#cfd3da` on `#0f1012` ≈ 11:1.
  Add/del tints must keep code text above 7:1.
- Focus order follows visual order: top bar → banners → toolbar → stops (left column then right) →
  floating bar → chat panel. The floating bar is reachable without traversing the whole document
  (`F6`-style region cycling).
- Landmarks: `banner`, `navigation` (tree), `main` (route/diff), `complementary` (chat),
  `contentinfo` (floating bar).
- Live regions: agent status changes, queue position, "stop 04 ready", publish results — all polite;
  errors assertive.
- Diff tables are not `<table>`s but each row exposes `aria-label` "added line 148: await
  self._cache.drop(order_id)" so the change type is spoken.
- All icon-only controls carry `aria-label`; the glyph characters (⌄ › ⇄ ↕ ↳) are `aria-hidden`.
- Zoom to 200% must keep the two-column route readable — columns stack below 1100px effective width.

---

## 7. Telemetry (from the brief's success metrics)

Instrument, at minimum: time from PR open to verdict; share of the diff read as raw diff outside the
route; number of visits to the PR before ship; stops viewed vs. skipped by tier; route generation
duration and failure rate; regeneration count; progress carried between snapshots; chat questions per
review and whether the answer became a comment; 👍/👎 on stops; feedback submissions with their
attached context.

---

## 8. Acceptance checklist

A screen is done when:

1. Every control implements rest / hover / active / focus-visible / disabled per §1.1.
2. Every AI-dependent surface has been checked with the agent killed mid-action.
3. Coverage numbers on screen are computed and reconcile with each other (README §13 story).
4. Stop numbers are plan-fixed and identical across route, plan card, filters and banners.
5. Diff mode, filters and viewed state survive a reload and a view switch.
6. The keyboard map works without a mouse for one full review, palette included.
7. Screen reader can walk a stop, its diff and its threads and hear the change types.
8. A 60+ file PR scrolls at 60fps with virtualisation on.
9. Reduced-motion mode has no shimmer, no blink, no animated scroll.
10. No colour-only signal remains for tier, read state or coverage.
