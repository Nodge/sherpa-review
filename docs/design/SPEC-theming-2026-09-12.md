# Sherpa light theme, settings, contrast, typography and responsive width · 2026-09-12

Delta spec for what is already in production (README §0–16 + SPEC-onboarding-2026-09-02). Only **changes** are covered here. Anything unmentioned stays as is. Reference implementation: `Sherpa.dc.html` in this package (settings menu: sliders icon in the header's right corner. The Contrast slider in the Tweaks panel is a design review tool, excluded from the product).

| Item | Prototype status | Production impact |
|---|---|---|
| Colour tokens (CSS variables, 124 total) | implemented | style refactor, no visual change |
| Light theme + system Auto mode (default Auto) | implemented | new |
| Rebuilt dark palette (neutral contrast +80 %) | implemented | **changes production appearance**. See §3 |
| Settings menu in the header (replaces the avatar) | implemented | new. Avatar/account removed |
| EN / RU language switch in the menu | implemented | connect to the existing translation. New strings cover the menu and tour |
| Font scale: 11px minimum, 13px base, rem | implemented | **changes production appearance**. See §5 |
| M / L text size | implemented | new |
| Responsive width, diff limit by mode | implemented | **changes production appearance**. See §6 |
| Selected states for segments and chips | implemented | changes production appearance. See §4 |
| Full diff file tree: compact folders, stop marker on the left | implemented | **changes production appearance**. See §6a |
| Viewed stop without opacity | implemented | changes production appearance. See §4 |

---

## 1. Theme model

Colours have one source: a set of CSS variables on `:root`. Each production colour has a variable named after its **old** hex (`#22252b` → `--c-22252b`), so migration is mechanical: replace the literal with `var(--c-<hex>)`. Alpha colours use the rgba digits (`rgba(0,0,0,.6)` → `--a-0006`). A few semantic pairs sit on top, with dark and light values that cannot be derived from one hex:

| Variable | Dark | Light | Use |
|---|---|---|---|
| `--seg-bg` | `#434954` | `#ffffff` | active segment background |
| `--seg-fg` | `#ffffff` | `#000000` | active segment text |
| `--seg-shadow` | `none` | `0 1px 2px rgba(20,24,32,.18), 0 0 0 1px rgba(20,24,32,.08)` | active segment shadow (raised white pill in the light theme) |
| `--chip-bg` | `#1e2240` | `#e8eaff` | enabled chip background |
| `--chip-bd` | `#3f4880` | `#b9c0f4` | enabled chip border |
| `--chip-fg` | `#c3caff` | `#2b3690` | enabled chip text |
| `--amber-btn` | `#e2954c` | `#b8641c` | amber primary button background (stale banner) |
| `--amber-btn-fg` | `#1b1508` | `#ffffff` | its text |

**Switching.** The `data-theme="dark" | "light"` attribute goes on `<html>`. The `:root[data-theme="light"] { … }` block overrides all variables. `color-scheme` changes with the theme (native scrollbars, inputs). **Auto** mode = `prefers-color-scheme` + a `change` listener, so the theme follows the system without a reload. **Auto is the default.** The `html/body` background is `var(--c-0d0e10)` to prevent a flash on load.

**Light theme rules not covered by the table:**
- The active segment (Overview/Route/Full diff, Triage/Full tour, menu switches) is a white pill with `--seg-shadow` on a grey track. Grey on grey reads as disabled in the light theme.
- Enabled chips (People/Bots/Resolved, file filter) use indigo fill/border/text (`--chip-*`) in both themes.
- The amber primary button in the stale banner uses `--amber-btn` with white text in the light theme (orange with black text on cream looked muddy).

## 2. Full token table

◆ marks a dark value that differs from production (rebuilt palette, §3). All other dark values match production 1:1.

| Token | Production (dark, current) | New dark | New light |
|---|---|---|---|
| `--seg-bg` | `—` | `#434954` | `#ffffff` |
| `--seg-fg` | `—` | `#ffffff` | `#000000` |
| `--seg-shadow` | `—` | `none` | `0 1px 2px rgba(20,24,32,.18), 0 0 0 1px rgba(20,24,32,.08)` |
| `--chip-bg` | `—` | `#1e2240` | `#e8eaff` |
| `--chip-bd` | `—` | `#3f4880` | `#b9c0f4` |
| `--chip-fg` | `—` | `#c3caff` | `#2b3690` |
| `--amber-btn` | `—` | `#e2954c` | `#b8641c` |
| `--amber-btn-fg` | `—` | `#1b1508` | `#ffffff` |
| `--c-0c0d0f` | `#0c0d0f` | `#0b0c0e` ◆ | `#f3f4f6` |
| `--c-0d0e10` | `#0d0e10` | `#0d0e10` | `#f6f7f9` |
| `--c-0e0f11` | `#0e0f11` | `#0f1012` ◆ | `#f0f1f5` |
| `--c-0f1012` | `#0f1012` | `#111214` ◆ | `#ffffff` |
| `--c-101113` | `#101113` | `#121315` ◆ | `#ffffff` |
| `--c-111214` | `#111214` | `#141517` ◆ | `#ffffff` |
| `--c-121316` | `#121316` | `#16171b` ◆ | `#fdfdfd` |
| `--c-131417` | `#131417` | `#18191d` ◆ | `#fafbfc` |
| `--c-141518` | `#141518` | `#1a1b1e` ◆ | `#f2f3f6` |
| `--c-15171b` | `#15171b` | `#1b1e24` ◆ | `#f3f4f8` |
| `--c-151619` | `#151619` | `#1b1c20` ◆ | `#f3f4f8` |
| `--c-161819` | `#161819` | `#1d2020` ◆ | `#e8eaef` |
| `--c-171a1f` | `#171a1f` | `#1f242b` ◆ | `#ffffff` |
| `--c-181a1e` | `#181a1e` | `#212429` ◆ | `#ffffff` |
| `--c-191c20` | `#191c20` | `#23272d` ◆ | `#e8eaee` |
| `--c-1a1d21` | `#1a1d21` | `#24292f` ◆ | `#e4e6eb` |
| `--c-1b1e22` | `#1b1e22` | `#262b30` ◆ | `#e9ecef` |
| `--c-1b1e24` | `#1b1e24` | `#262b34` ◆ | `#e2e5ea` |
| `--c-1e2126` | `#1e2126` | `#2c3038` ◆ | `#e0e2e7` |
| `--c-1f2228` | `#1f2228` | `#2d323b` ◆ | `#e2e5ea` |
| `--c-22252b` | `#22252b` | `#333741` ◆ | `#dadee4` |
| `--c-24272d` | `#24272d` | `#363b44` ◆ | `#d2d5dd` |
| `--c-26292f` | `#26292f` | `#3a3f48` ◆ | `#cdd3da` |
| `--c-262a30` | `#262a30` | `#3a404a` ◆ | `#c9ced6` |
| `--c-2a2e34` | `#2a2e34` | `#414851` ◆ | `#c5cad2` |
| `--c-2b2f36` | `#2b2f36` | `#434954` ◆ | `#c8cdd5` |
| `--c-2f333a` | `#2f333a` | `#4a515c` ◆ | `#bbc2cb` |
| `--c-303540` | `#303540` | `#4c5466` ◆ | `#b7bec8` |
| `--c-313640` | `#313640` | `#4e5666` ◆ | `#bfc6cf` |
| `--c-33373e` | `#33373e` | `#515863` ◆ | `#b1b8c2` |
| `--c-33383f` | `#33383f` | `#515a65` ◆ | `#afb5c0` |
| `--c-333842` | `#333842` | `#515a6a` ◆ | `#b0b7c1` |
| `--c-3a3f47` | `#3a3f47` | `#5e6673` ◆ | `#a1a7b3` |
| `--c-43474e` | `#43474e` | `#6e7580` ◆ | `#9198a2` |
| `--c-4a4f57` | `#4a4f57` | `#7b8390` ◆ | `#828894` |
| `--c-4a5160` | `#4a5160` | `#7b87a0` ◆ | `#7b8390` |
| `--c-5e636b` | `#5e636b` | `#dae4f3` ◆ | `#28303b` |
| `--c-5f646d` | `#5f646d` | `#dae4f3` ◆ | `#28303b` |
| `--c-6b7078` | `#6b7078` | `#e7f1ff` ◆ | `#19212d` |
| `--c-8a8f98` | `#8a8f98` | `#ffffff` ◆ | `#0c1420` |
| `--c-9ba1ab` | `#9ba1ab` | `#ffffff` ◆ | `#000813` |
| `--c-a9aeb7` | `#a9aeb7` | `#ffffff` ◆ | `#00000a` |
| `--c-b9bec7` | `#b9bec7` | `#ffffff` ◆ | `#00000a` |
| `--c-c2c7d0` | `#c2c7d0` | `#ffffff` ◆ | `#000000` |
| `--c-c7cad1` | `#c7cad1` | `#ffffff` ◆ | `#000000` |
| `--c-cfd3da` | `#cfd3da` | `#ffffff` ◆ | `#000000` |
| `--c-e0e2e7` | `#e0e2e7` | `#ffffff` ◆ | `#000000` |
| `--c-e9eaee` | `#e9eaee` | `#ffffff` ◆ | `#000000` |
| `--c-f0f1f4` | `#f0f1f4` | `#ffffff` ◆ | `#000000` |
| `--c-7f8cff` | `#7f8cff` | `#7f8cff` | `#5a68e8` |
| `--c-101223` | `#101223` | `#101223` | `#ffffff` |
| `--c-8f9bff` | `#8f9bff` | `#8f9bff` | `#4c5ae0` |
| `--c-9aa6ff` | `#9aa6ff` | `#9aa6ff` | `#5462e3` |
| `--c-aeb6ff` | `#aeb6ff` | `#aeb6ff` | `#4350cc` |
| `--c-b3bcff` | `#b3bcff` | `#b3bcff` | `#3a47bd` |
| `--c-dfe2ff` | `#dfe2ff` | `#dfe2ff` | `#262f8a` |
| `--c-c9cdf0` | `#c9cdf0` | `#c9cdf0` | `#3a4390` |
| `--c-a6adde` | `#a6adde` | `#a6adde` | `#5a63a8` |
| `--c-6f76a8` | `#6f76a8` | `#a3a9d6` ◆ | `#4a5290` |
| `--c-5c6288` | `#5c6288` | `#7d83ad` ◆ | `#6b719f` |
| `--c-4b5074` | `#4b5074` | `#767ba3` ◆ | `#6d729a` |
| `--c-3a3f60` | `#3a3f60` | `#3a3f60` | `#c3c7e6` |
| `--c-262a45` | `#262a45` | `#262a45` | `#dfe2fa` |
| `--c-2a2e4a` | `#2a2e4a` | `#2a2e4a` | `#dde0f8` |
| `--c-22253a` | `#22253a` | `#22253a` | `#e6e8fb` |
| `--c-131424` | `#131424` | `#131424` | `#f0f1fc` |
| `--c-141520` | `#141520` | `#1a1b2d` ◆ | `#f0f1ff` |
| `--c-86d9a8` | `#86d9a8` | `#86d9a8` | `#1e7f47` |
| `--c-6cc38f` | `#6cc38f` | `#6cc38f` | `#268f52` |
| `--c-2b7a55` | `#2b7a55` | `#3a8f66` ◆ | `#2f8557` |
| `--c-3f7a5a` | `#3f7a5a` | `#3f7a5a` | `#46a672` |
| `--c-4f7f66` | `#4f7f66` | `#5f9478` ◆ | `#3a835d` |
| `--c-1f3d2c` | `#1f3d2c` | `#1f3d2c` | `#bfe4cd` |
| `--c-25422f` | `#25422f` | `#25422f` | `#cde9d8` |
| `--c-24422f` | `#24422f` | `#24422f` | `#cde9d8` |
| `--c-132019` | `#132019` | `#182e20` ◆ | `#e4f6ea` |
| `--c-16211a` | `#16211a` | `#1d3022` ◆ | `#e8f7ec` |
| `--c-e8a29c` | `#e8a29c` | `#e8a29c` | `#c33f39` |
| `--c-e0736c` | `#e0736c` | `#e0736c` | `#cf4640` |
| `--c-dd8a84` | `#dd8a84` | `#dd8a84` | `#c94842` |
| `--c-d99a95` | `#d99a95` | `#d99a95` | `#b5423c` |
| `--c-e8cfcd` | `#e8cfcd` | `#e8cfcd` | `#7a2622` |
| `--c-d5c0be` | `#d5c0be` | `#d5c0be` | `#87332e` |
| `--c-7f5a56` | `#7f5a56` | `#a0736e` ◆ | `#a45a54` |
| `--c-3d2a2c` | `#3d2a2c` | `#3d2a2c` | `#f0d2d0` |
| `--c-171315` | `#171315` | `#1f1719` ◆ | `#feecea` |
| `--c-151316` | `#151316` | `#1b171b` ◆ | `#feefec` |
| `--c-e2b878` | `#e2b878` | `#e2b878` | `#9d6410` |
| `--c-c9a464` | `#c9a464` | `#c9a464` | `#7f5612` |
| `--c-e2954c` | `#e2954c` | `#e2954c` | `#d8791c` |
| `--c-d99a5c` | `#d99a5c` | `#d99a5c` | `#b46a1f` |
| `--c-d3b183` | `#d3b183` | `#d3b183` | `#8a5f1c` |
| `--c-e6d7bd` | `#e6d7bd` | `#e6d7bd` | `#3f3014` |
| `--c-d8c9ad` | `#d8c9ad` | `#d8c9ad` | `#5a4a24` |
| `--c-9a8f7c` | `#9a8f7c` | `#9a8f7c` | `#6e6144` |
| `--c-8a7550` | `#8a7550` | `#9c8760` ◆ | `#7f6c3e` |
| `--c-6b5b39` | `#6b5b39` | `#6b5b39` | `#bba777` |
| `--c-4a4230` | `#4a4230` | `#4a4230` | `#d9c9a4` |
| `--c-3d3524` | `#3d3524` | `#3d3524` | `#ecdfc4` |
| `--c-3d3a2c` | `#3d3a2c` | `#3d3a2c` | `#e9dfc3` |
| `--c-241f14` | `#241f14` | `#241f14` | `#fbf3df` |
| `--c-191712` | `#191712` | `#231e14` ◆ | `#fffaec` |
| `--c-1b1508` | `#1b1508` | `#1b1508` | `#1b1508` |
| `--a-0006` | `rgba(0,0,0,.6)` | `rgba(0,0,0,.6)` | `rgba(20,24,32,.16)` |
| `--a-0005` | `rgba(0,0,0,.5)` | `rgba(0,0,0,.5)` | `rgba(20,24,32,.12)` |
| `--a-00055` | `rgba(0,0,0,.55)` | `rgba(0,0,0,.55)` | `rgba(20,24,32,.14)` |
| `--a-00062` | `rgba(0,0,0,.62)` | `rgba(0,0,0,.62)` | `rgba(20,24,32,.18)` |
| `--a-00065` | `rgba(0,0,0,.65)` | `rgba(0,0,0,.65)` | `rgba(20,24,32,.18)` |
| `--a-13141692` | `rgba(13,14,16,.92)` | `rgba(13,14,16,.92)` | `rgba(246,247,249,.92)` |
| `--a-78966` | `rgba(7,8,9,.66)` | `rgba(7,8,9,.66)` | `rgba(236,238,242,.7)` |
| `--a-16183525` | `rgba(16,18,35,.25)` | `rgba(16,18,35,.25)` | `rgba(255,255,255,.35)` |
| `--a-12714025513` | `rgba(127,140,255,.13)` | `rgba(127,140,255,.13)` | `rgba(90,104,232,.12)` |
| `--a-12714025516` | `rgba(127,140,255,.16)` | `rgba(127,140,255,.16)` | `rgba(90,104,232,.16)` |
| `--a-12714025528` | `rgba(127,140,255,.28)` | `rgba(127,140,255,.28)` | `rgba(90,104,232,.22)` |
| `--a-6616011011` | `rgba(66,160,110,.11)` | `rgba(66,160,110,.11)` | `rgba(38,143,82,.10)` |
| `--a-22410810210` | `rgba(224,108,102,.10)` | `rgba(224,108,102,.10)` | `rgba(207,70,64,.09)` |

## 3. Rebuilt dark palette

User complaints about contrast were confirmed: the two lowest grey levels were 3.1:1 and 3.9:1 (text requires 4.5:1). The decision was made visually, using a slider on the running interface: **neutral tokens are stretched away from the page background by +80 % in dark and +40 % in light** (`new = bg + (old − bg) × 1.8`, clamped). **Accent colours (indigo, green, red, amber) are unchanged**. The result is in the table in §2. One manual adjustment beyond the formula raises `--c-6f76a8` (the hint below "Open the route") to ≈7:1 in both themes.

For developers: the grey hierarchy in the dark theme is now flat. Muted labels (paths, counters, kickers) are almost white. This is a deliberate choice based on complaints. If feedback says "everything is equally loud", the next step is to restore 2–3 levels without lowering the overall level.

## 4. State changes (both themes)

| Element | Production before | After |
|---|---|---|
| Viewed stop (left column) | `opacity:.72` on the whole column | no opacity. Heading `--c-c7cad1` (was `--c-f0f1f4`), paragraph `--c-9ba1ab` (unviewed uses `--c-c2c7d0`) |
| Read file chip in a stop | `opacity:.62` | no opacity. Only the green checkmark shows it is read |
| "✓ Viewed" button hover | grey background `--c-1b1e24` | green: bg `--c-25422f`, border `--c-2b7a55` |
| "Mark viewed" button hover | `--c-1b1e24` | same + text `--c-c7cad1` |
| Active segment | bg `#2b2f36`, text `#f0f1f4` | bg `--seg-bg`, text `--seg-fg`, shadow `--seg-shadow` |
| Enabled chip | bg `#22252b`, border `#2f333a`, text `#e0e2e7` | `--chip-bg / --chip-bd / --chip-fg` |
| "Open the 34 lines" (Other stop) | grey fill `#22252b` (read as disabled) | transparent, border `--c-4a4f57`, text `--c-e9eaee`/500, hover bg `--c-1b1e24` + border `--c-5e636b`. "Ask the agent…" unchanged |
| Floating action bar | shrink-to-fit from `left:50%` | + `width:max-content; white-space:nowrap` (wrapped to 3 lines in L mode) |

## 5. Typography

All `font-size` values use **rem** (`html { font-size: 100% }`), so the interface respects the system/browser font size. The minimum and base sizes also increase:

| Production, px | New, px | rem | Use |
|---|---|---|---|
| 7 · 8 | 8 | 0.5 | checkbox checkmarks (decorative) |
| 9 · 9.5 · 10 · 10.5 | **11** | 0.6875 | kickers, badges, ⌘K, paths, gutters (exception: stop marker in the tree is 10px, §6a) |
| 11 | 11.5 | 0.7188 | mono metadata, counters |
| 11.5 | 12 | 0.75 | controls, filenames, code |
| 12 | 12.5 | 0.7813 | secondary UI text |
| 12.5 | **13** | 0.8125 | base UI text (`body`) |
| 13 | 13.5 | 0.8438 | stop paragraphs |
| 13.5 | 14 | 0.875 | inputs, tour heading |
| 14 | 14.5 | 0.9063 | — |
| 15 | 15.5 | 0.9688 | section headings |
| 19 · 22 · 24 | unchanged | 1.1875 · 1.375 · 1.5 | screen headings |

Code: 12px mono (was 11.5), line-height stays 20px, so line density is unchanged. Control heights (23–30px) stay in px. All were checked for overflow in L mode.

**M / L text size** (settings menu): M uses the scale above. L uses `html { font-size: 112.5% }` (14.6px base, 12.4px minimum). One line implements it because everything uses rem.

## 6. Width and responsiveness

The interface has **no** overall width limit (verified: the limit hurts side by side). Instead:

| Item | Production | New |
|---|---|---|
| Route content | `max-width:1560px` | no limit |
| Route / Full diff side margins | 30px | `clamp(30px, 2.4vw, 60px)` |
| Stop narrative column | `minmax(300px,368px)` | `clamp(300px, 26%, 500px)` |
| Narrative ↔ diff gap | 40px | `clamp(40px, 3vw, 72px)` |
| Agent panel | 392px | `clamp(392px, 26vw, 560px)` |
| Full diff file tree | 290px | `clamp(320px, 22vw, 560px)` |
| Overview | `max-width:1300px` | `max-width:1700px` |
| **Code panels (stop diff column, Full diff cards, Full diff header)** | unlimited | `max-width: var(--diff-max)`: **unified 1280px, side by side 1920px** (×1.5). Left-aligned, with the remaining space empty on the right |

`--diff-max` switches with the global diff mode (⇄) and on scenario change. The onboarding frame is recalculated after switching. `min-width:1440px` stays.

## 6a. File tree in Full diff

Production problem: the filename had less than half the row, so almost everything was truncated. The rebuilt row gives the name priority:

```
[02] ⌄ □ edit_policy.py                              pci  +96
 ▲   ▲ ▲ └ name: flex:1, ellipsis                    └ tag  └ +N, 30px column, right-aligned
 │   │ └ read-state 10×10 (unchanged)
 │   └ chevron only for folders (files keep the 9px slot for alignment)
 └ stop marker: absolute, left:3px, sits in the indentation area without taking space from the name
```

| Item | Production | New |
|---|---|---|
| Panel padding | 14px | `12px 10px` |
| Nesting indent | `8 + depth×13` px | folders `4 + depth×10`, files `max(26, 4 + depth×10)` (space for the marker) |
| Single-child folder chains | each folder is a row | **collapse into one row** `domain/policies` (like compact folders in VS Code). Clicking the row collapses the whole chain. Descendant depth decreases by the number of collapsed levels. With a filter active, only visible children count |
| Stop marker `01…07` | badge on the right, 11px, border `#2b2f36`, text `#8a8f98` | **on the left, pinned to the panel edge**: 17×13, radius 3, **10px** mono (the only deliberate exception to the 11px minimum, a secondary marker), text `--c-4a4f57`, border `--c-1e2126`. `title` "explained in stop 02" |
| "not placed" | hatched badge with text on the right | same slot on the left: 17×13 hatch `repeating-linear-gradient(115deg, --c-33373e 0 2px, --c-1b1e22 2px 4px)`, no text. `title` "no route stop covers this file" |
| `+N` | right | right, `min-width:30px; text-align:right`. The counts form a column read from top to bottom |
| Row `title` | — | `<name> · N of M lines seen` *(implemented as `<path> · N of M changed lines viewed`. Deviation, `docs/decisions.md` 2026-09-13: the name is already in the row, while the path moved out of the label and lives only in the tooltip)* |

Row order: chevron · marker (absolute) · read-state · name · `pci` · `+N`. At 1440px, the filename gets ~110–140px more than in production.

## 7. Settings menu (header)

Replaces the "RS" avatar. The skill runs locally, so there is no account, name or sign out.

**Trigger.** A 28×28 icon button, radius 7, border `--c-24272d`, 15px "sliders" icon (gear and sun icons read as "theme only"). Open state: bg `--c-1b1e24`, border `--c-2f333a`, icon `--c-e0e2e7`. `title` = "Settings" / "Settings".

**Panel.** `position:absolute; right:0; top:32px`, width 252, padding 6, bg `--c-171a1f`, border `--c-313640`, radius 10, shadow `0 18px 44px --a-00055`, z 61. A transparent backdrop at z 60 sits below it (clicking outside closes it). Esc closes it. Opening it closes the Ship and filter menus.

Rows (top to bottom), setting row height 34px, action items 30px, separator 1px `--c-1e2126`:

| # | Row | Control | Values | Persistence |
|---|---|---|---|---|
| — | `SETTINGS` kicker | 11px mono `--c-5e636b`, letter-spacing .07em | | |
| 1 | Theme / Theme | mini segment (h22, radius 5) | **Auto · Dark · Light** | `sherpa.theme` |
| 2 | Language / Language | mini segment | **EN · RU** | `sherpa.lang` |
| 3 | Text size / Text size | mini segment | **M · L** | `sherpa.textsize` |
| — | separator | | | |
| 4 | Replay onboarding / Replay onboarding | item + `8 · steps` on the right | resets the tour flag, starts at 01 (= palette command) | |
| 5 | Commands / Commands | item + kbd `⌘K` | closes the menu, opens the palette | |

The sections allow expansion: a new setting adds a 34px row with a mini segment. A new action adds a 30px item after the separator.

## 8. Interface language

The EN / RU switch in the menu connects to the **existing full interface translation**. The prototype translates only the shell (tabs, search, feedback, agent states, menu, tour), which does not define the work scope. New strings to translate cover the settings menu and eight tour steps. Their source of truth is the `I18N` object and `TOUR_RU` array in `Sherpa.dc.html`:

| Key | EN | RU |
|---|---|---|
| theme / auto / dark / light | Theme / Auto / Dark / Light | see `I18N.ru` |
| language / textSize | Language / Text size | see `I18N.ru` |
| replay / steps / commands | Replay onboarding / steps / Commands | see `I18N.ru` |
| tourKicker / skip / back / next / start | HOW SHERPA WORKS / Skip tour / Back / Next / Start reviewing | see `I18N.ru` |

The Russian text for the eight tour steps is in `TOUR_RU` in the prototype (heading ≤2 lines, body ≤~220 characters. Russian is longer, and the 350px card was checked for every step). Changing language with the tour open recalculates the card position.

## 9. Persistence and telemetry

**Decision: settings use the existing server storage** (the tour flag will move there too). Keys and values: `theme` (auto|dark|light, default auto), `lang` (en|ru), `textsize` (m|l). The prototype uses localStorage `sherpa.theme` / `sherpa.lang` / `sherpa.textsize` only as a behaviour reference. The read requirement stays: apply the theme before the first frame to prevent a flash. Use system Auto until the server responds.

Telemetry (in addition to the five tour events): `settings_changed { key: theme|lang|textsize, value, source: menu }`, `theme_resolved { mode: auto, resolved: dark|light }` on startup.

**Decisions (2026-09-12)**
1. The default theme is **Auto**.
2. Settings use **existing server storage**.
3. RU already has a **full interface translation**. The menu switch connects to it. The dictionary in §8 and `TOUR_RU` cover only the eight tour steps and new menu strings missing from the existing translation.
4. Size S is **not needed**.

**Open question**
- `--diff-max` 1280 / 1920 values were chosen on a 27″ display at 50 % scale. Check on a real 5K display.

## 10. Acceptance checklist

- [ ] No colour literals in components, only `var(--…)`. All 124 variables resolve in both themes.
- [ ] The dark theme matches the table in §2 (including ◆ values), the light theme matches the light column.
- [ ] Dark/Light switches instantly without a reload. Auto reacts to system theme changes.
- [ ] No white/black flash when loading the saved theme.
- [ ] The active segment in the light theme is a white pill with a shadow. An enabled chip is indigo in both themes.
- [ ] Viewed stops and read files have no `opacity`. "✓ Viewed" hover is green.
- [ ] All text is ≥4.5:1 against its background in both themes (including raised cards and banners).
- [ ] No `font-size` < 11px (except 8px checkmarks). All sizes use rem. Changing the system font size scales the interface.
- [ ] L mode: the action bar is on one line, the header does not wrap, the tour card fits all 8 steps in EN and RU.
- [ ] At 2560px: narrative column 500px, unified diff ≤1280, split ≤1920, file tree 560, agent panel 560. The right side is empty, content aligns left.
- [ ] Menu: Esc and clicking outside close it. Opening it closes Ship/filter. All three settings survive a reload.
- [ ] RU: menu and tour translated per §8, the rest uses the existing translation. Switching with the tour open preserves the card position.
- [ ] Default theme Auto. Settings load from server storage before the first frame.
- [ ] Full diff tree: single-child folders collapse, stop markers form one column at the left edge, `+N` aligns right, filenames are not truncated at 1440px for paths of depth ≤3.
- [ ] The prototype Contrast slider and SCENARIOS dock do not enter production.
