# Sherpa additions, 2026-08-26

Handoff spec for 5 groups of design requests. Interactive mockup: **`Sherpa Additions.dc.html`** (in this directory, opens in a browser, all interactive elements work, so click them). Tokens, fonts and shared rules are in `README.md` §Design tokens. The main interface's state matrix is in `SPEC-elements.md`. This document covers additions only.

| Block | What | Phase | Findings |
|---|---|---|---|
| **1a** | Context gap rows in the diff | M2F | №23 |
| **1b** | Icon set (12 glyphs) | M2F | №6, №10, №15, №27 |
| **1c** | "Comments on the PR" modal | M5 | №9b |
| **1d** | Comment composer + line comment | M5 | №26 |
| **1e** | Discussion card in Overview | M5 | №5 |

Status: **1a is already in the main prototype** (`Sherpa.dc.html`, the gap row above the first hunk is clickable). 1b–1e have not been added to the prototype. They are mockups for implementation.

---

## 1a. Context gap row

### Anatomy

The row remains a diff row: height **24px**, background `#111214`, top/bottom borders `1px solid #191c20` (which border appears depends on position), counter 11px mono `#5e636b`.

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

A missing direction gets an **empty gutter cell** (`width:46px;height:24px`), not a grey placeholder. Empty space doesn't look like a broken button, and the grid stays aligned.

Semantics: arrow = direction in which visible context grows. `↑` adds 20 lines to the **top** edge of the hidden block (adjacent to the hunk above, rendered above the gap row), `↓` to the **bottom** edge (rendered below the gap row, adjacent to the hunk below). Repeated clicks reduce the counter by 20 per click.

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

Hover highlights **only its own half** and replaces the counter with the action label, so the increment and direction are visible before the click.

### Behaviour and data

- The increment is 20 lines. The last click loads the entire remainder (< 20).
- Server response slower than 150 ms → keep the "pressed" state until the lines arrive (`loading…`), disable targets, ignore repeat clicks.
- Loading error: replace the counter with `could not load more · retry`, make the entire row a single retry target. Previously loaded lines remain visible.
- Loaded lines are ordinary diff context rows (`ctx` numbers `#43474e`, code `#cfd3da`). They participate in file search and range selection.
- Context expansion **does not change** file reading progress (partial/full), because context is not a change.
- Side-by-side mode uses the same gap row, with targets in the first and fourth grid columns (`46px 14px 1fr 46px 14px 1fr`), one per side. There is one counter, in the left code column.

### Accessibility

- The gap row is **one tab stop**. `←/→` switch between its arrows, `Enter`/`Space` load more lines.
- Target `aria-label`: "load 20 lines above, 347 lines hidden". After loading, `aria-live="polite"`: "20 lines loaded, 327 hidden".
- Glyphs use `aria-hidden`, like all other icons (SPEC §accessibility).

---

## 1b. Icon set

A custom set rather than a ready-made one, because exactly 12 glyphs at one optical size are needed.

- `viewBox="0 0 16 16"`, drawing in a **12.8×12.8** square inside 16×16 (1.6px space on each side). The optical centre matches the centre of 11–12.5px rows without manual offsets.
- **stroke** `stroke="currentColor"`, width 1.35–1.7, `stroke-linecap/linejoin: round`. The only filled icon is the thumb (`ic-thumb`), whose silhouette is only recognizable when filled. This departs from README §Assets ("fill=currentColor"), because filled shapes blur at 13px.
- ship as **one sprite** `<symbol id="ic-*">`, insert via `<use href="#ic-…">`. No font icons.

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

Additional composer icons (1d): `ic-bold`, `ic-italic`, `ic-link`, `ic-code`, `ic-codeblock`, `ic-list`, `ic-trash`. Same geometry and rules.

### Rendering rules

- Sizes: **13px** in 11–12.5px rows, **14px** in 25×25 icon buttons and in the toolbar,
  **15px** on the Ship button, **9px** in the 11×11 box. No intermediate sizes.
- Colour comes only from the parent's `color`. The icon is slightly dimmer than the text (`#6b7078` with `#9ba1ab` text).
- **Required**: `viewBox` on the `<svg>` itself + `flex:none`. Without these, icons shrink inside a `display:flex` button (this happened before, with icons rendering at 11px instead of 14px).
- `aria-hidden` on the icon, label on the button.
- A collapsed chevron uses a **separate** `ic-chev-right`, not a rotated `ic-chev-down`, because rotation animation changes the apparent stroke width.

---

## 1c. "Comments on the PR" modal

Width **620px**, `#0f1012`, border `1px solid #2b2f36`, radius 11px, shadow `0 18px 50px rgba(0,0,0,.55)`, backdrop `rgba(8,9,10,.55)`.

Order: header → list of written comments → composer. Existing comments first, then input.

**Header** (`#141518`, bottom `1px solid #1e2126`, padding 13px 15px): "Comments on the PR" 13px/600, context `outside the diff · 4821` 10.5px mono `#6b7078`, on the right a yellow chip `N drafts · go out on Ship` and a 25×25 close button (14px icon).

**List.** Item = author (19px avatar, 12px name), state chip, time, actions, body.

| Item type | Border / background | Chip |
|---|---|---|
| Draft | `1px solid #33301f`, left edge `2px solid #6b5b39`, background `#131210` | `draft · publishes on ship` (yellow) |
| Published | `1px solid #1e2126`, background `#111214` | `published` (grey) |
| Being edited | `1px solid #3c4560`, left edge `2px solid #7f8cff`, background `#12141c` | `editing` (blue) |

- Actions appear only on your own draft: pencil and trash, **25×25** buttons, 14px icons, colour `#8a8f98`, trash hover `#e0736c` / border `#4a2f2d`. Published items have no actions.
- The same markdown renderer renders the body and the threads.

**Edit in place.** The pencil turns the item itself into an editor (1d: same toolbar, same layouts, "Save changes" / "Cancel" buttons). The bottom composer remains for new comments only, so the texts do not mix.

**Delete in 2 steps within the item.** Trash opens a row with `#170f0f` / `1px solid #4a2f2d`: "Delete the draft? It will not be published" + "Delete" / "Keep". No modal over a modal. Deletion cannot be undone, so confirmation is required.

**Scroll.** Only the list scrolls. The header and composer stay fixed, `max-height: min(330px, 100vh − 260px)`, `overscroll-behavior: contain`. Thin `#2b2f36` scrollbar, transparent track. A 26px bottom gradient edge is the only sign that the list continues. Below a viewport height of 520px, the composer shrinks to 64px. Newest first. After saving, the list scrolls to the new draft and the composer clears.

**Empty:** "No comments on the PR yet. What you write here goes out with the review on Ship."

**Publishing.** No "Publish" buttons. Below the composer, show "Drafts go out as one batch on Ship, together with the line comments".

Shortcuts use 11.5px keycaps (`⌘⏎` save, `Esc` close), not 10.5px grey text.

---

## 1d. Comment composer

One component in 3 places: **thread reply**, **line comment**, **modal 1c**.

**Toolbar** (`#141518`, bottom `1px solid #1e2126`, padding 5px 6px): 6 buttons, 26×24, 14px icons for bold, italic, link, inline code, code block, list. No headings, because a 3-line comment does not need them. Hover `#22252b` / `#e0e2e7`, pressed `#2b2f36`.

**Two layouts for one field**, switched on the right of the toolbar (20px segments, active `#2b2f36`/`#f0f1f4`):

- **Visual** (default): typing, caret, selection and formatting directly in the rendered body.
- **Markdown**: the same text as source, `IBM Plex Mono` 12px.

There is **one** text model, markdown. "Visual" is neither a preview nor a second format. The body is edited with the same renderer that displays published comments, then serialized back to markdown (`**` `*` `` ` `` ```` ``` ```` `- ` `[]()`). The toolbar works in both layouts. In "Visual", it acts on the caret/selection and inserts a placeholder ("text", "code") when the selection is empty. In "Markdown", it wraps the selection in markers. The layout choice is saved per user.

The "Visual" placeholder is a **separate layer** (`position:absolute`, `pointer-events:none`), not field content, otherwise it would become part of the comment text.

**Action labels:** "Save draft" ("Save changes" when editing) and "Cancel". No "Send" or "Publish", because only Ship publishes. `⌘B/⌘I/⌘K` duplicate the buttons, `⌘⏎` = save, `Esc` = cancel (with confirmation when the text is not empty).

**Autosave** (SPEC §2.17, ≤1s after input), status below the field on the right:

| State | Appearance |
|---|---|
| In progress | `saving…` 11.5px `#6b7078` |
| Succeeded | `ic-check` `#5e8a6d` + `saved as a draft · 14:02` |
| Failed | `not saved, draft stays in the field, will retry`, `#e0736c` |
| Draft exists, field closed | field returns with text, border `#4a4230`, background `#141210`, chip `draft · publishes on ship` |
| Resting (no draft) | collapsed to one 32px row: "Reply…" + `ic-pencil` |

### Comment on a code line

- The pencil sits in the line's **right gutter**, 23×23 button `#7f8cff`, 15px icon, shadow `0 1px 4px rgba(0,0,0,.45)`. It appears on row hover (`#141518`) and keyboard focus. For a selected range, it appears on the range's first line.
- The composer expands **below the line, in the diff flow**, left offset **62px** (2 gutters + marker column), background `#0d0e10`, top/bottom borders `1px solid #191c20`, body width ≤620px.
- Context above the field: `new comment · line 118` + chip `draft · publishes on ship`.
- Existing thread on a line: someone else's published comment has no pencil (only "Reply" / "Resolve"). Your own draft is edited **in place** in its card (blue edge, "editing" chip). The body does not move into the modal or the bottom field.

---

## 1e. Discussion card in Overview

Decision: the card is a **summary and entry point**, not a feed. Thread bodies live beside the code. Only threads **outside the diff** expand in the card, because there are few and nowhere else to read them. The card handles the real scale (86 threads, 85 from bots) without becoming a wall of text.

Column width 360px, border `1px solid #24272d`, radius 9px, background `#0f1012`.

1. **Header:** "Discussion" 13px/600 + `86 threads · 48 open` 11px mono `#6b7078`.
2. **Filters:** the same additive chips as in the route toolbar, `Humans 12` `Bots 74` `Resolved 38` (on: `#22252b` / `1px solid #2f333a` / `#e0e2e7`, off: transparent / `1px solid #22252b` / `#6b7078`). Default: humans on, bots and resolved off. State is shared with the diff and route.
3. **Participants:** row 7px 13px, avatar 19px (bots use a square r5 + `bot` badge), name 11.5px mono, subline 11px `#6b7078` ("3 open · last 40 min ago"), counter 11px mono (`#e2954c` when any are open, otherwise `#6b7078`), `ic-chev-right`. At most **6 rows**, then "N more participants". Bots are not participants. One row per bot with a counter, and bot thread bodies never appear in the card.
4. **"Outside the diff N"** is a fold (`ic-chev-down`, rotated −90° when collapsed). Inside are thread cards `1px solid #1e2126` / `#111214`: author, state chip, body 12px, and where available a code line (one line, truncated) and link (one line, `text-overflow:ellipsis`), metadata 10.5px mono, "Reply" button. Markdown headings render as ordinary bold text. Bodies longer than 4 lines are truncated with "expand". The card never contains nested replies.
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

**1a**: where to store loaded context between passes, nowhere (reset on reload, proposed) or in session storage together with partial reading progress.

**1d**: implement "Visual" with contentEditable + serialization (as in the mockup), or use a ready-made markdown editor. This determines whether lossless round-tripping can be guaranteed.

**1e**: whether resolved bot threads count in the bot's row counter or disappear entirely when `Resolved` is off. Participant order (by open thread count, as now, or by last activity). Whether an anchor from Overview directly to a specific thread beside the code is needed.

**Telemetry** (carried over from the previous handoff, still relevant): events for expanding a gap row (clicks to reveal the full file measure "route did not cover the context"), opening the line composer, switching Visual/Markdown layouts, deleting a draft.
