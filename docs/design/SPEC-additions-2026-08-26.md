# Sherpa additions, 2026-08-26

Handoff specification for five groups of design requests. Live mockup: **`Sherpa Additions.dc.html`**
(in this directory, opens in a browser, every interactive element works, so click away).
Tokens, fonts and general rules are in `README.md` §Design tokens. The main interface state
matrix is in `SPEC-elements.md`. Only additions go here.

| Block | What | Phase | Findings |
|---|---|---|---|
| **1a** | Context gap rows in the diff | M2F | №23 |
| **1b** | Icon set (12 glyphs) | M2F | №6, №10, №15, №27 |
| **1c** | "Comments on the PR" modal | M5 | №9b |
| **1d** | Comment composer + line comment | M5 | №26 |
| **1e** | Discussion card in Overview | M5 | №5 |

Status: **1a is already in the main prototype** (`Sherpa.dc.html`, the bridge above the first hunk
is clickable). 1b–1e are not in the prototype. They are mockups for implementation.

---

## 1a. Context gap row

### Anatomy

The row remains a diff row: height **24px**, background `#111214`, borders `1px solid #191c20`
at the top/bottom (which one is present depends on position), counter 11px mono `#5e636b`.

The interactive elements sit in the diff's 2 gutter columns. The grid stays the same:

```
[ ↑ 46px ][ ↓ 46px ][ 16px ][ counter — code column ]
```

- arrow target: **46×24**, `background:transparent`, no border.
- glyph 13px (`ic-arrow-up` / `ic-arrow-down`), resting colour `#4a4f57`.
- the counter text is **not clickable** because the expansion direction would be unclear.

### Directions

| Gap row position | Arrows |
|---|---|
| Top of file (before the first hunk) | only `↑`, nowhere to expand downwards |
| Between hunks | `↑` and `↓` |
| Bottom of file ("to the end of the file") | only `↓` |
| Remainder < increment (20) | one `↕` target in the first column, label "N unchanged lines, expand" |

A missing direction is an **empty gutter cell** (`width:46px;height:24px`), rather than a grey
placeholder: empty space does not look like a broken button, and the grid stays in place.

Meaning: the arrow points in the direction the visible context grows. `↑` adds 20 lines
to the **top** edge of the hidden block (adjacent to the hunk above, rendered above the bridge row),
`↓` to the **bottom** (rendered below the bridge, adjacent to the hunk below). Clicks can repeat,
the counter decreases by 20 per click.

### States

| State | Target background | Glyph colour | Counter |
|---|---|---|---|
| Resting | transparent | `#4a4f57` | `347 unchanged lines`, `#5e636b` |
| Hover `↑` | `#181a1e` | `#9ba1ab` | replaced with `+20 lines above · 347 unchanged`, `#9ba1ab` |
| Hover `↓` | `#181a1e` | `#9ba1ab` | `+20 lines below · 347 unchanged` |
| Pressed | `#1e2126` | `#c7cad1` | `loading…` |
| Direction absent | — | — | empty cell |
| Remainder < 20 | same as resting | `#4a4f57`, glyph `↕` | `7 unchanged lines, expand` |
| Fully expanded | row disappears | — | — |

Hover highlights **only its own half** and replaces the counter with the action label, so the step and
direction are visible before clicking.

### Behaviour and data

- The increment is 20 lines. The last click loads the entire remainder (< 20).
- Server response slower than 150 ms → keep the "pressed" state until the lines arrive
  (`loading…`), targets disabled, repeated clicks ignored.
- Loading error: replace the counter with `could not load · retry`, the whole row
  becomes one retry target. Previously loaded lines remain.
- Loaded lines are ordinary diff context rows (`ctx` numbers `#43474e`, code `#cfd3da`),
  included in file search and range selection.
- Loading context **does not change** the file's read state (partial/full). Context is not
  changed content.
- In side-by-side mode the bridge is the same, with targets in the first and fourth grid columns
  (`46px 14px 1fr 46px 14px 1fr`), one on each side. There is one counter, in the left
  code column.

### Accessibility

- The gap row is **one tab stop**. `←/→` switch between its arrows, `Enter`/`Space` load more lines.
- Target `aria-label`: "load 20 lines above, 347 lines hidden". After loading,
  `aria-live="polite"`: "20 lines loaded, 327 hidden".
- Glyphs use `aria-hidden`, like all other icons (SPEC §accessibility).

---

## 1b. Icon set

A custom set rather than a ready-made one, because exactly 12 glyphs at one optical size are needed.

- `viewBox="0 0 16 16"`, drawing in a **12.8×12.8** square inside 16×16 (1.6px of space on all sides),
  the optical centre matches the centre of 11–12.5px text lines without manual offsets.
- **stroke** `stroke="currentColor"`, width 1.35–1.7, `stroke-linecap/linejoin: round`.
  The only filled icon is the thumb (`ic-thumb`), its silhouette is recognizable only when filled.
  This departs from README §Assets ("fill=currentColor"). At 13px, filled
  shapes look blurry.
- Deliver as **one sprite** `<symbol id="ic-*">`, insert with `<use href="#ic-…">`.
  No font icons.

| id | Where it appears |
|---|---|
| `ic-search` | ⌘K palette, file filter, tree search |
| `ic-chev-down` | expanded folder/fold, thread group |
| `ic-chev-right` | collapsed versions of the above + navigation in the participant list |
| `ic-thumb` | Ship button (15px) |
| `ic-pencil` | comment on a line (gutter), edit a draft |
| `ic-check` | "Viewed" (11×11 box → 9px glyph), buttons, Review complete |
| `ic-cross` | close modal, clear filter, clear selection |
| `ic-swap` | unified / side-by-side toggle |
| `ic-arrow-up` / `ic-arrow-down` | context gap rows (1a) |
| `ic-updown` | gap row with a remainder < increment |
| `ic-reply` | "replying to" in deeply nested threads |

Also for the composer (1d): `ic-bold`, `ic-italic`, `ic-link`, `ic-code`, `ic-codeblock`,
`ic-list`, `ic-trash`, with the same geometry and rules.

### Rendering rules

- Sizes: **13px** in 11–12.5px rows, **14px** in 25×25 icon buttons and in the toolbar,
  **15px** on the Ship button, **9px** in the 11×11 box. No intermediate sizes.
- Colour comes only from the parent's `color`. The icon is slightly dimmer than the text (`#6b7078` with `#9ba1ab` text).
- `viewBox` on the `<svg>` itself + `flex:none` are **required**: inside a `display:flex` button,
  the icon shrinks without them (this happened before, icons rendered at 11px instead of 14px).
- `aria-hidden` on the icon, label on the button.
- The collapsed chevron uses a **separate** `ic-chev-right`, rather than a rotated `ic-chev-down`: animating
  the rotation changes the apparent stroke width.

---

## 1c. "Comments on the PR" modal

Width **620px**, `#0f1012`, border `1px solid #2b2f36`, radius 11px,
shadow `0 18px 50px rgba(0,0,0,.55)`, backdrop `rgba(8,9,10,.55)`.

Order: header → list of written comments → composer. Existing comments first, then input.

**Header** (`#141518`, bottom `1px solid #1e2126`, padding 13px 15px): "PR comments" 13px/600,
context `outside the diff · 4821` 10.5px mono `#6b7078`, a yellow chip on the right
`N drafts · publish on Ship` and a 25×25 close button (14px icon).

**List.** Item = author (19px avatar, 12px name), state chip, time, actions, body.

| Item type | Border / background | Chip |
|---|---|---|
| Draft | `1px solid #33301f`, left edge `2px solid #6b5b39`, background `#131210` | `draft · publishes on ship` (yellow) |
| Published | `1px solid #1e2126`, background `#111214` | `published` (grey) |
| Being edited | `1px solid #3c4560`, left edge `2px solid #7f8cff`, background `#12141c` | `editing` (blue) |

- Actions only on your own draft: pencil and trash, **25×25** buttons, 14px icons,
  colour `#8a8f98`, trash hover `#e0736c` / border `#4a2f2d`. Published comments have no actions.
- The body uses the markdown renderer (the same one that displays threads).

**Edit in place.** The pencil turns the item itself into an editor (1d: same toolbar, same
layouts, "Save changes" / "Cancel" buttons). The bottom composer remains for new
comments only, so the texts do not mix.

**Delete in two steps within the item.** Trash opens a row `#170f0f` / `1px solid #4a2f2d`:
"Delete the draft? It will not be published" + "Delete" / "Keep". No modal over a modal.
There is no undo after deletion, so confirmation is required.

**Scrolling.** Only the list scrolls: header and composer stay fixed,
`max-height: min(330px, 100vh − 260px)`, `overscroll-behavior: contain`. Thin scrollbar,
`#2b2f36`, transparent track. The 26px bottom gradient edge is the only sign
of more items below. Below 520px viewport height, the composer shrinks to 64px. Newest first.
After saving, the list scrolls to the new draft, and the composer clears.

**Empty:** "No comments on the PR yet. What you write here goes out with the review on Ship."

**Publishing.** No "Publish" buttons: below the composer, a line reads
"Drafts are published as one batch on Ship, together with line comments".

Shortcuts use 11.5px keycaps (`⌘⏎` save, `Esc` close), not 10.5px grey text.

---

## 1d. Comment composer

One component in 3 places: **thread reply**, **line comment**, **modal 1c**.

**Toolbar** (`#141518`, bottom `1px solid #1e2126`, padding 5px 6px): six 26×24 buttons, 14px icons,
bold, italic, link, inline code, code block, list. No headings: a three-line
comment does not need them. Hover `#22252b` / `#e0e2e7`, pressed `#2b2f36`.

**Two layouts of one field**, switch on the right of the toolbar (20px segments, active
`#2b2f36`/`#f0f1f4`):

- **Visual** (default): typing, caret, selection and formatting directly in the rendered body.
- **Markdown**: the same text as source, `IBM Plex Mono` 12px.

There is **one** text model, markdown. "Visual" is neither a preview nor a second format: the body is edited
with the same renderer that displays published comments and serialized back to markdown
(`**` `*` `` ` `` ```` ``` ```` `- ` `[]()`). The toolbar works in both layouts: in "Visual", at the
caret/selection, inserting a template ("text", "code") when the selection is empty. In "Markdown",
it wraps the selection in markers. The layout choice is saved per user.

The "Visual" placeholder is a **separate layer** (`position:absolute`, `pointer-events:none`),
outside the field content, otherwise it will end up in the comment text.

**Action labels:** "Save draft" (when editing, "Save changes") and "Cancel".
Neither "Send" nor "Publish", only Ship publishes. `⌘B/⌘I/⌘K` duplicate the buttons,
`⌘⏎` = save, `Esc` = cancel (with confirmation if the text is not empty).

**Autosave** (SPEC §2.17, ≤1s after input), status below the field on the right:

| State | Appearance |
|---|---|
| In progress | `saving…` 11.5px `#6b7078` |
| Succeeded | `ic-check` `#5e8a6d` + `saved as a draft · 14:02` |
| Failed | `not saved, draft stays in the field, will retry`, `#e0736c` |
| Draft exists, field closed | field returns with text, border `#4a4230`, background `#141210`, chip `draft · publishes on ship` |
| Resting (no draft) | collapsed to one 32px row: "Reply…" + `ic-pencil` |

### Comment on a code line

- Pencil in the line's **right gutter**, 23×23 button `#7f8cff`, 15px icon, shadow
  `0 1px 4px rgba(0,0,0,.45)`. Appears on row hover (`#141518`) and keyboard focus.
  On a selected range, it sits on the first line of the range.
- The composer expands **below the line in the diff flow**, left offset **62px** (two gutters +
  marker column), background `#0d0e10`, borders `1px solid #191c20` top/bottom, body width ≤620px.
- Context above the field: `new comment · line 118` + chip `draft · publishes on ship`.
- Existing thread on a line: another person's published comment has no pencil (only
  "Reply" / "Resolve"). Your own draft is edited **in place**, in its own card
  (blue edge, "editing" chip), the body moves to neither a modal nor the bottom field.

---

## 1e. Discussion card in Overview

Decision: the card is a **summary and entry point**, rather than a feed. Thread bodies live by the code. The card
expands only threads **outside the diff**, which are few and have nowhere else to be read.
The card handles the real scale (86 threads, 85 from bots) without becoming a wall of text.

Column width 360px, border `1px solid #24272d`, radius 9px, background `#0f1012`.

1. **Header:** "Discussion" 13px/600 + `86 threads · 48 open` 11px mono `#6b7078`.
2. **Filters:** the same additive chips as in the route toolbar, `People 12` `Bots 74`
   `Resolved 38` (on: `#22252b` / `1px solid #2f333a` / `#e0e2e7`, off: transparent /
   `1px solid #22252b` / `#6b7078`). Default: people on, bots and resolved off. State is shared
   with the diff and route.
3. **Participants:** row 7px 13px, avatar 19px (bot: square r5 + `bot` badge), name 11.5px
   mono, subtitle 11px `#6b7078` ("3 open · last 40 min ago"), counter 11px mono
   (`#e2954c` if any are open, otherwise `#6b7078`), `ic-chev-right`. Maximum **6 rows**,
   then "N more participants". Bots are not participants: one row per bot with a counter,
   bot thread bodies never appear in the card.
4. **"Outside the diff N"**, a fold (`ic-chev-down`, rotated −90° when collapsed). Inside are thread
   cards `1px solid #1e2126` / `#111214`: author, state chip, 12px body, and, when available,
   a code line (one line, truncated) and link (one line, `text-overflow:ellipsis`),
   10.5px mono metadata, "Reply" button. Markdown headings render as ordinary bold text.
   Bodies longer than 4 lines are truncated with "expand". The card never contains nested replies.
5. **Footer:** "All threads beside the code →" link + "Comment on the PR" button (opens 1c).

**Empty:** "No threads yet. Discussion starts beside the code".

---

## Acceptance checklist

**1a**
- [ ] The file's top gap row has one `↑` arrow, the bottom one has one `↓`, a middle one has both.
- [ ] Clicking `↑` adds lines above the gap row (numbers from the hunk above), `↓` adds them below (numbers towards the hunk below).
- [ ] The counter decreases by 20 per click. A remainder < 20 expands via one `↕` target. At zero, the row disappears.
- [ ] Hover highlights only its own half and replaces the counter with the action label.
- [ ] Target 46×24, counter text not clickable, diff grid stays in place in every state.
- [ ] One tab stop, `←/→` inside, `aria-live` after loading.
- [ ] A loading error keeps the lines already displayed.

**1b**
- [ ] All 19 glyphs (12 base + 7 editor) ship in one sprite, `viewBox` on `<svg>`, `flex:none`.
- [ ] No icons drawn with font characters remain in the UI (~65 places).
- [ ] Sizes only 9 / 13 / 14 / 15px. Colour inherits from `color`.
- [ ] Icon buttons: measured svg width equals its attribute (flex shrinking regression).

**1c**
- [ ] Draft, published and edited items are visually distinct (edge + chip).
- [ ] Editing happens in place, and the bottom composer does not pick up its text.
- [ ] Deletion confirmation appears within the item, with no modal over a modal.
- [ ] Only the list scrolls. Header and composer stay in place. The page below the modal stays still.
- [ ] No "Publish" button. The line about Ship appears below the composer.

**1d**
- [ ] One component in 3 places. Only the context label differs.
- [ ] "Visual" supports actual input (not a preview). Text serializes to markdown without loss for `**`, `*`, `` ` ``, ```` ``` ````, `- `, `[]()`.
- [ ] The placeholder does not enter the comment text.
- [ ] Autosave ≤1s, 3 status states.
- [ ] The line pencil appears on hover and keyboard focus. Composer below the line, offset 62px.

**1e**
- [ ] A PR with 86 threads (85 from bots) does not become a wall of text: list ≤6 rows + 2 threads outside the diff.
- [ ] Filters are shared with the diff and route.
- [ ] Long links and code blocks do not break the 360px width.

---

## Open questions for the team

**1a**, where to store loaded context between visits: nowhere (reset on reload,
our suggestion) or in session storage together with the partial read state.

**1d**, implement "Visual" with contentEditable + serialization (as in the mockup) or use an existing
markdown editor. This determines whether we can guarantee a lossless round-trip.

**1e**, whether resolved bot threads count in the bot row's counter or disappear entirely when
`Resolved` is off. Participant order (by open thread count, as now, or by
last activity). Whether Overview needs an anchor directly to a specific thread by the code.

**Telemetry** (carried over from the previous handoff, still applies here): events for expanding a
bridge (clicks to the full file measure "the route did not cover the context"),
opening a line composer, switching Visual/Markdown layout, deleting a draft.
