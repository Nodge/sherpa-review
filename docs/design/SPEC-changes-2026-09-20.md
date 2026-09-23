# Sherpa spec changes, 2026-09-20

> **Implementation departures (2026-09-21, `../decisions.md`, "Threads, issues and the composer").** The issue switch defaults to on, rather than off. Only a resolved thread without my draft starts collapsed. Everything else, including bot threads beside code and in the modal, starts expanded. There is no tracking of "new reply since the last pass" or amber dot. Thread expansion lives in tab memory and is not stored per-session. The review host adapter computes thread resolution, rather than the client. The capability is named `commentIssues`. The issue flag goes to the host when saving a draft, rather than when publishing. Each issue comment has a Resolve button (§5), rather than only the root as in the prototype. New tokens get semantic names.

Five changes on top of production (08-26 handoff + 09-02 onboarding + 09-12 theme): 4 changes requested by the customer (§1–4) and a redesign
of base controls, with one rule for hover / pressed / disabled / focus across all buttons, links, switches, tabs, chips,
icon buttons and checkboxes (§5).
**What to inspect.** The iteration overview page is `Sherpa Changes 2026-09-20.dc.html` (contents: ctl · 2a · 2b · 2c · 2e · 2d,
theme switches in Tweaks: auto / dark / light. Everything is interactive: markers, Resolve, Reply, Delete-confirm, switches).
Reference implementation in the interactive prototype `Sherpa.dc.html`: 2b (descriptions of stops 02–03) and all of §3 (threads beside the code in stop 02,
file `order_service.py`: edge markers, expansion, message anatomy, Resolve, Reply composer with issue switch, Edit/Delete).
The PR modal (§4) and line composer (§1) are not shown in the prototype, only on the overview page.
The colours below are dark values. In production, use tokens from `SPEC-theming-2026-09-12.md`.

## 1. "Open an issue" switch in the composer (2a)

**What.** Above the editor border, below the context heading ("new comment · line 118" /
"replying to …" / "NEW COMMENT ON THE PR"), a 22px row with a switch + label and nothing on the right.

An issue is a review host concept: a flag on a review comment that must be resolved before merging
(not a ticket in an issue tracking system). The team decides who resolves it. The UI does not explain this. The switch marks the comment as an issue, and the flag goes to the host together
with the text on Ship.

| Element | Spec |
|---|---|
| switch | `role="switch"`, 30×17, radius 9. Off: border `#343941`, bg `#1b1e24`, thumb 11px `#8a8f98` left 2. On: border+bg `#7f8cff`, thumb `#101223` left 14. Transition .15s |
| label | 12px. Off `#9ba1ab`, on `#e9eaee`. "Open an issue" everywhere, with no explanation |

The gap to the editor border is 8px. The row appears in all 3 composer locations (PR modal, line comment,
thread reply) and when editing a draft (state is preserved).

**Model.** `CommentDraft.issue: boolean` (default false). `publishBatch` passes the flag to the host together
with the comment. The draft card has an `issue` chip (mono 9.5px `#aeb6ff` on `#191c2b`, border `#3c4560`)
next to the `draft` chip. Published: no switch, the same `issue` chip appears in the comment header immediately after the author's
name, as a flag on an ordinary comment, not a separate card. Thread status (open / resolved) works as for any thread.

**Unsupported host.** `ReviewHost.capabilities.issueComments === false` (GitHub) → the row is **absent from the DOM**:
no disabled state, no tooltip. The composer starts at the border. Spacing: 11px heading → 9px → border.
The flag is read once when opening the PR.

**Keyboard/a11y.** The switch is a tab stop before the editor, `Space` toggles it,
`aria-checked`, `aria-label` "Open an issue, off / on".

**Ship menu** (layout unchanged): the draft counter gets a "· 1 issue" suffix when
at least one flag is set.

## 2. Stop description typography (2b)

**Supported markup** (`route.section` validator): paragraphs (blank line separator), lists, either bulleted
with `- ` or `* `, or numbered with `1. `, up to 4 items, inline `` `code` ``, `**bold**`, links `[text](url)`.
**Forbidden:** everything else, including headings, nested lists, code blocks, tables, images, blockquotes, italics, strikethrough, horizontal rules.
Any links are allowed if they help with the review context: internal (file, stop, diff anchor: `#stop-s3`, `#file-…`)
and external (documentation, issues, dashboards). External links open in a new tab.

**Budget:** total visible text length only, **≤ 840 characters** (constant `STOP_PARAGRAPH_MAX_CHARS`). Counts visible text characters, including text, code and link text.
Link URLs and markup markers do not count. The limit depends on neither text size (M/L) nor window width.
Paragraph and list item counts are unlimited. Exceeding the budget → the section fails validation and goes
for regeneration with a reduced limit (like any invalid section). The UI neither truncates nor adds an ellipsis.

**Prompt:** keep the "what changed → what follows from it" formula. Use lists only for
items of the same kind (conditions, files, flags). A concluding paragraph is required after a list.

**Rendering** (`paraStyle` container unchanged: 0.8438rem/1.62, token `c2c7d0` is `#ffffff` / `#000000`, viewed → `9ba1ab`). All colours use tokens from the 09-12 spec, values given as dark / light:

| Block | Spec |
|---|---|
| `<p>` | margin 0. Each subsequent paragraph has `margin-top: 7px` |
| `<ul>` / `<ol>` | margin `6px 0 0`, padding-left 17px. `<li>` margin-bottom 2px, bullet/number in the text colour |
| `<a>` | token `8f9bff` (`#8f9bff` / `#4c5ae0`), no underline, hover `b3bcff` (`#b3bcff` / `#3a47bd`), the product's shared link style. Internal links use the same jump as file chips (without `scrollIntoView`) |
| `<code>` | mono 0.75rem, radius 4, padding 1px 4px. Tokens bg `191c20` (`#23272d` / `#e8eaee`), border `24272d` (`#363b44` / `#d2d5dd`), text `cfd3da` (`#ffffff` / `#000000`), the same as inline code in comments |
| `<b>` | 700, token `e9eaee` (dark `#ffffff`, light `#000000`). After the 09-12 contrast pass it matches body colour in both themes, so bold differs by weight. Tone is an open question in §7.4 |

The bridge phrase and "why this stop changed" are plain text, without markup. Size L (×1.125) uses rem throughout.
Reference: `Sherpa.dc.html` → `mdPara()` / `mdInline()`. Stops 02 and 03 were rewritten for the new supported markup.

## 3. Collapsing a whole thread beside the code (2c)

A collapsed thread beside the code is a **marker on the hunk card's left edge**. It occupies no diff lines. The collapsed row
with a preview (chevron · author · anchor · first line · "N replies" · status, h22) is used **only in the PR modal** (§4), where there is no code.
Remove the "N replies ›/⌄" button (collapse replies only, release 1) beside the code.

- The row grid stays the same (`46 | 46 | 16 | 1fr`): space for markers is **not reserved**. The row uses `position:relative`.
  The marker uses `position:absolute; left:-15px; top:1px` and floats on the card's left edge, halfway outside. The hunk card
  gets `margin-left:14px` (taken from the outer gutter, the 1280/1920 limits are not recalculated). The card has no `overflow:hidden`,
  rounding applies to the header and last row. In side-by-side mode the right half's marker sits on the divider.
- Marker: h18, radius 9, avatar 16 (bot radius 4) + mono 10px counter (`n+1` messages. Resolved uses `✓`, opacity .7).
  Rest: background `0d0e10` (the page colour, to cover the border), 1px `24272d` border. Hover/press use the steps in §5.
  Expanded: 1px `7f8cff` border, `191c2b` background, `aeb6ff` counter.
  Multiple threads on one line share a marker with a total count and the first author's avatar.
- Clicking expands the thread **below the line**, across the full row width, with left padding up to the code column (108px), no further,
  and a 2px `7f8cff` left edge. Clicking the marker again collapses it. There is no separate ✕ in the header. Collapsed height is zero.
- Default: **all threads collapse into a marker**, except threads with your own draft and threads with a new reply since the last pass
  (these have an `e2954c` dot next to the counter until first expanded). **Resolved threads always start collapsed**, both beside code and in the PR modal,
  regardless of drafts/new replies. Their marker is a muted `✓`.
- **What counts as a resolved thread.** Hosts without per-comment resolution (GitHub): resolved = the host's thread status.
  The review host (per-comment resolution): a thread is resolved if **it has at least one comment with the `issue` flag and all
  comments with `issue` are resolved**. A thread without any `issue` is open (there is nothing to resolve or close.
  The resolved rule does not collapse it). The client computes this from `watchThreads`, recalculating on every Resolve / Reopen.
- "Collapse all / expand all" (quiet mono, h20) in the hunk header appears when the file has ≥ 2 threads and acts on the file. There is no "N threads · K expanded" counter in the header. The markers replace it.
- Resolved does not change the expanded block's background or opacity (always `141518`). Only the chip and edge show status: open `7f8cff`, resolved `33383f`.
- Expanded thread: header has avatar 18 · author · source chip · anchor/time · **Resolve button** (same pattern as Viewed toggle §5: open uses ghost h22 r5 "○ Resolve", border `2b2f36`, text `9ba1ab`. Resolved uses "✓ Resolved" bg `16211a`, border `25422f`, text `86d9a8`. Clicking toggles it, title is "Reopen" when resolved. Hover/press use the steps in §5. Drafts have no button). Header min-height 24, 6px to the body (same for all messages, with or without a button). Body 13px/1.6.
  Replies are visible immediately, with no separate reply collapsing (a thread has two states: marker and expanded).
  Replies have **no lines at all** (no vertical line on the left or dividers between messages): 12px of space between messages,
  the avatar and name mark the start of a message. Text aligns with the root text column (`padding-left:27px` = avatar 18 + gap 9), with 18px avatars at every level.
  Beyond 1 level, replies are flat, with "↳ replying to". Per-session state: `threadOpen: {threadId → bool}`.
- Actions below the message text: "Reply" (accent) for everyone. Your own messages also have "Edit · Delete" (Link muted. "Delete" hover `e0736c`). Deleting replaces the action row with a confirmation in the same position: "Delete comment?" immediately followed (gap 9) by Danger solid "Delete" and Ghost "Cancel" (h23), with no hints. Esc = Cancel. No modal. "Edit" puts the editor in place of the text.
- A new reply in a collapsed thread (reactively from the host) adds an `e2954c` dot to the marker. The thread does not expand itself.
- **Remove the "Comments from · People / Bots / Resolved" filter** from the stop toolbar (SPEC-elements §Threads, per-session `threadsShow`).
  It served the same purpose, reducing noise from bot and resolved threads, but hid them completely. Collapsing now handles this:
  bot and resolved threads collapse into markers by default, with the markers still visible and clickable. The divider and "Comments from" label
  also leave the toolbar. Remove `threadsShow` from state. The stop's comment counter stays unchanged.
- Keyboard: the marker is a tab stop, `Enter/Space`, `aria-expanded`. title = "Expand: author · first line".
- The 1280/1920 limits (09-12 spec) are not recalculated. Code width does not shrink.

## 4. "PR comments" modal: width and threads (2d)

**Width:** `width: clamp(620px, 68vw, 1120px)` (was a fixed 620). 1280 → 870, 1440 → 979, ≥1648 → 1120.
Below a 1280 window width: `100vw − 48px`. Side padding 18px (was 15). List:
`max-height: min(60vh, 640px)` (was 330), only the list scrolls, header and composer stay fixed, 26px bottom gradient as in 1c.
Comment and reply body: `max-width: 760px`. Longer lines at 13px are unreadable. The extra width goes to the thread header and padding.

**Threads inside.** A PR comment is the thread root, rendered as the card variant in §3:
card `#111214`, border `#1e2126`, radius 8, padding 10px 12px. Draft: `#131210`, 2px `#6b5b39` left edge.
replies sit under a left line `#26292f` (padding-left 12), always visible when the thread is expanded (there is no "N replies" button,
because threads outside the diff are short). Beyond 1 level, replies are flat with "↳ replying to".
"Reply" below any message opens the composer directly below it (in the message text column, max-width 733) with the issue switch (§1). "Cancel"/Esc collapses it. There is no "Reply…" row.
Collapsed by default: drafts no, bots yes, people no, **resolved yes** (resolved thread definition in §3). The modal header has no "collapse all" or draft counter. The new comment composer has no heading or "draft empty" status.
Order is newest first. Edit/delete your own messages with "Edit · Delete" links below the text (§3), with pencil/trash removed from the header.

## 4a. Draft chip labels (delta)

The unpublished comment/reply chip is shortened to **`draft`** everywhere (was "draft · publishes on ship"):
threads beside code, replies in the tree, PR modal, the composer's "draft exists" field, and the context heading
of the line composer. Chip styles stay the same (mono 9.5px `#e2b878` on `#241f14`, border `#4a4230`).
The "publishes on ship" explanation stays only in the caption below the composer ("Drafts publish as one batch
on Ship…") and in the floating panel ("N drafts will publish"). Overrides README §3 and SPEC-elements §Reply composer.

## 4b. Composer and buttons in the light theme (delta to the 09-12 spec. Button states in §5)

- **"Save draft / Save changes" button** (secondary solid) uses new tokens instead of `22252b / 343941 / e9eaee`:
  `--btn-bg`, `--btn-bd`, `--btn-fg`, `--btn-bg-hover`, `--btn-shadow`. Dark: `#333741 / #4a515c / #ffffff / #434954 / none`.
  Light: `#ffffff / #8b94a3 / #0c1420 / #eef0f4 / 0 1px 2px rgba(20,24,32,.12)`, a white button with a dark border,
  replacing the grey fill that looked disabled. The same tokens apply to Retry / Regenerate and other secondary solid buttons in production.
- **Active "Visual / Markdown" segment** uses the segmented control tokens from the 09-12 spec: `--seg-bg / --seg-fg / --seg-shadow`
  (as in Triage | Full tour), replacing `2b2f36 / f0f1f4`.
- **Editor focus** has no glow (`0 0 0 3px rgba(127,140,255,.10)` removed). Composer field states
  (the same in all three locations: beside a line, thread reply, PR modal. Production currently differs, bring it into line with the table):

| state | border | background | visible content |
|---|---|---|---|
| rest, empty (collapsed) | 1px `262a30` (`#3a404a` / `#c9ced6`) | `111214` | single h32 row "Reply…" / "Comment on line 118…", pencil on the right. No toolbar |
| rest, has text, unfocused | 1px `2b2f36` (`#434954` / `#c8cdd5`) | `111214` | toolbar + text. Autosave status below the field |
| focus | 1px `7f8cff` (`#7f8cff` / `#5a68e8`) | `111214` | toolbar + text + caret. **No shadow/glow** |
| draft saved, field closed | draft card (`33301f`, 2px `6b5b39` left edge) | `131210` | `draft` chip, text. Clicking the pencil restores the field in the "has text" state |
| autosave error | 1px `2b2f36` | `111214` | text stays, "not saved, retrying" status in `e0736c` |

  Rest → focus transition: only the border colour changes, no transition. The issue switch (§1) sits above the field in every state except "collapsed".

## 5. Base control redesign: one state rule

Live table: `Sherpa Changes 2026-09-20.dc.html`, `ctl` section (both themes). Overrides the state matrix in
SPEC-elements wherever they differ.

**One hover rule.** Hover changes only the surface: a background appears or moves one step. Text and border
stay the same. Pressing moves one more step along the same scale. Grey surface scale: transparent → `1b1e24` → `22252b` → `2b2f36`
(dark `#262b34 → #333741 → #434954`, light `#e2e5ea → #dadee4 → #c8cdd5`). Filled buttons use three tones of their own colour.
Reason: after the 09-12 contrast pass, text tokens `8a8f98 … e0e2e7` are one colour within each theme, so "brighter text" on hover is invisible.
Exceptions: links (no surface → colour follows the accent scale, no underline in any state) and trash (icon turns red with the background for a destructive action).
Disabled everywhere = `opacity:.45; cursor:default`, no hover. Focus only on `:focus-visible`, with a `2px solid var(--focus)` ring
(`#7f8cff` / `#5a68e8`), offset 2px (−2px inside a segment). No shifts, shadows or transition (switch: .15s).

| control | rest | hover | pressed |
|---|---|---|---|
| Primary (Ship, Ask the agent, Next) | bg `7f8cff`, ink `101223`, h29, r7 | bg `8f9bff` | bg `6b78e6` |
| Attention («What changed…») | `--amber-btn` / `--amber-btn-fg` | `--amber-btn-hover` | `--amber-btn-active` |
| Secondary solid (Save…, Retry, Regenerate) | `--btn-bg` / `--btn-bd` / `--btn-fg` / `--btn-shadow` | `--btn-bg-hover` | `--btn-bg-active`, shadow removed |
| Danger solid (Delete) | bg `3a1f1e`, border `5c3230`, text `f2c4c0`, h23, r5 | bg `4a2725` | bg `5c3230` |
| Viewed toggle · on | bg `16211a`, border `25422f`, text `86d9a8` | bg `1f3d2c` | bg `25422f` |
| Resolve toggle · off / on (thread root header. Hosts with per-comment resolution: on every resolvable message) | "○ Resolve" like Viewed off, h22 r5, icon 11px, dot always `e2954c` (open needs attention, not danger) / "✓ Resolved" like Viewed on. Title when on: "Reopen" | bg `1b1e24` / `1f3d2c` | bg `22252b` / `25422f` |
| Ghost (Cancel, Feedback, Search, Agent) | border `2b2f36`, text `9ba1ab`, transparent | bg `1b1e24` | bg `22252b` |
| Danger ghost (Request changes) | border `3d2a2c`, text `d99a95` | bg `171315` | bg `3d2a2c` |
| Viewed toggle · off | like Ghost, h23 | bg `1b1e24` | bg `22252b` |
| Quiet mono (⇄ unified, collapse all) | text `5e636b`, no border, mono 11px, h22, r4 | bg `1b1e24` | bg `22252b` |
| Link / Link muted | `8f9bff` / `8a8f98`, no underline | `b3bcff` / `8f9bff` | `7f8cff` / `b3bcff`, no underline in any state |
| Switch off / on | track `1b1e24` + border `343941`, knob `8a8f98` / track `7f8cff`, knob `101223` | track `22252b` / `8f9bff` | track `2b2f36` / `6b78e6`, knob ×.85 |
| Tabs / segment (view, preset, zone. Small variant: editor mode) | container `161819` (small `0f1012`) + `24272d`. Active `--seg-bg/-fg/-shadow` does not react. Inactive `8a8f98` | inactive bg `1b1e24` | bg `22252b` |
| Filter chip off / on | border `22252b`, text `6b7078` / `--chip-bd`, `--chip-bg`, `--chip-fg` (accent fill, as already used in the production toolbar. Grey fill in the light theme looks disabled) | bg `1b1e24` / `--chip-bg-hover` | bg `22252b` / `--chip-bg-active` |
| Icon ghost 25×25 (pencil, ✕) | border `2b2f36`, icon `8a8f98` | bg `1b1e24` | bg `22252b` |
| Icon danger 25×25 (trash) | like ghost | bg `171315`, icon `e0736c` | bg `3d2a2c`, icon `e0736c` |
| Toolbar icon 26×24 | no border, icon `8a8f98`. "On" = bg `22252b` | bg `1b1e24` | bg `22252b` |
| Chevron 20×20 | icon `6b7078` | bg `1b1e24` | bg `22252b` |
| Checkbox 12px off / on | border `3a3f47` / bg `2b7a55`, border `3f7a5a`, ✓ `0d0e10` | bg `1b1e24` / `3f7a5a` | bg `22252b` / `25422f` |

Labels: a checkbox or switch label is part of the control (`<label>`). Hovering and clicking the text act on the box/track.

Rules: 10 button variants (Viewed and Resolve share the "action toggle" pattern), do not add more. The same action uses the same variant everywhere ("Cancel" = Ghost,
"Save…" = Secondary solid, "Delete" = Danger solid). Heights 29 / 28 / 24 / 23 / 22 and radii 7 / 6 / 5 / 4 follow the table in the mockup.
**Three kinds of fill:** actions use neutral fill (`--btn-*`, Secondary solid). An "on" state, allowing several
at once, uses accent fill (`--chip-*`, filter chips, Viewed on uses green as a special case). A single choice from a group uses
a white item inside a container (`--seg-*`, tabs and segments). A chip must not look like a button, or a button like a selected chip.
Replace existing production `style-hover` rules that change text/border colour (`color:e0e2e7; border-color:3a3f47`, etc.) with `background:1b1e24`.

New tokens: `--focus`, `--chip-bg-hover` (`#262c52` / `#dfe2fb`), `--chip-bg-active` (`#2e3566` / `#d3d8f8`), `--btn-bg-active`, `--amber-btn-hover`, `--amber-btn-active`, `--c-6b78e6` (`#6b78e6` / `#4353cf`),
`--c-4a2725` (`#4a2725` / `#f2c9c6`).

## 6. State and contracts (delta)

- `CommentDraft.issue: boolean`. `ReviewHost.capabilities.issueComments: boolean` (review host true, GitHub false).
- `publishBatch` passes the `issue` flag to the host with the comment. Issue status (open/resolved) is read reactively through `watchThreads`.
- per-session: `threadClosed: {id → bool}`, `prThreadClosed`, `replyOpen`.
- Stop schema: `paragraph` stays a string using a Markdown subset. The validator uses the vocabulary and budget in §2.

## 6a. What gets removed from production

- The "Comments from · People / Bots / Resolved" filter in the stop toolbar and per-session `threadsShow` (§3).
- The "N replies ›/⌄" button (collapsing replies only) on code threads (§3).
- The collapsed thread row beside code (chevron · author · preview) stays only in the PR modal (§3, §4).
- In the PR modal: "collapse all", the "N drafts · publishes on Ship" chip, the "New PR comment" heading and "draft empty" status,
  the "Reply…" row, pencil/trash in the draft header (§4).
- Glow on the focused editor. The open/resolved status chip (replaced by the Resolve button, §5).
- The vertical line to the left of replies and dividers between messages (§3).

## 7. Acceptance checklist

1. The switch sits above the editor in all three locations and when editing a draft. Its state survives autosave.
2. On hosts without the capability the row is absent from the DOM. Composer height matches current production.
3. Drafts and published comments with the flag carry an `issue` chip after the author's name. The Ship menu counts issues.
4. A description with multiple paragraphs, a list (ul or ol) and a link renders according to §2. Headings/code blocks/text > 840 characters fail validation.
5. Inline code in descriptions looks identical to inline code in comments (same token).
6. Beside the code (§3): a collapsed thread has a marker on the left edge of the card at its line, with no reserved column or change to code width. All threads are collapsed by default except drafts and new replies. Resolved threads are always collapsed (the review host requires ≥ 1 `issue` with every `issue` resolved). Clicking expands the thread below the line with a 108px inset to the code column. In the PR modal (§4), it is a collapsed row with a preview and "N replies".
7. "Collapse all" appears in the hunk header with ≥ 2 threads. The toolbar has no "Comments from" filter. Counters stay unchanged.
8. PR modal at 1440: 979px, at 1920: 1120. List up to 640px. Body ≤ 760.
9. Replies to PR comments are written in place, with the issue switch. Replies are visible without clicking.
10. Keyboard: switch `Space`, marker and chevron `Enter/Space` + `aria-expanded`. Esc closes the modal, not the thread. Beside code there is no separate button to collapse replies.
11. All draft chips read `draft`, without "publishes on ship" at the end.
12. The composer field follows the states in §4b: collapsed → has text → focus (accent border, no shadow) → `draft` card. Only the border colour changes.
13. Dark and light themes: all new colours use tokens. Preview contrast in the collapsed row ≥ 4.5:1.
14. Controls in §5: each variant's hover moves the background one step, pressing moves it a second step. Text and border stay the same. Links use accent colours, no underline. Trash icon uses `e0736c`.
15. Controls in §5: disabled = opacity .45 with no hover. Focus ring only via keyboard. No existing `style-hover` changes text or border colour.
16. Controls in §5: 10 button variants, "Cancel" / "Save…" / "Delete" are the same everywhere. Heights and radii follow the table.

## 8. Open questions

1. Is a separate issue-thread filter needed after removing "Comments from", or are the `issue` chip in the thread header and amber dot in the Resolve button enough.
2. The "new reply in a collapsed thread" dot: count as viewed on expansion or on scroll (see the decision in the requirements §3.1: manual actions only → on expansion).
3. Bold in descriptions: keep the distinction in weight only (as now after the contrast pass) or make body text one tone quieter again in both themes.
