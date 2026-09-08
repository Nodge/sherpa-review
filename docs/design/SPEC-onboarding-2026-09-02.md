# Sherpa onboarding on the first visit 2026-09-02

Handoff spec for the eight-tip tour. Storyboard with 1:1 cards and the reason for each step: **`Sherpa Onboarding.dc.html`**. Live implementation: **`Sherpa.dc.html`**, the "07 · First run" scenario in the SCENARIOS dock and the "Replay the onboarding tour · 8 steps" palette command. Tokens and shared rules: `README.md` §Design tokens and §16. Main interface state matrix: `SPEC-elements.md`. This spec covers onboarding only.

| What | Stage | Status |
|---|---|---|
| Eight tips over the live interface | M5 | **fully implemented in the prototype** |
| "Show once" flag + resume from step | M5 | implemented with localStorage (storage choice needed, see §9) |
| "Replay the onboarding tour" palette command | M5 | implemented |
| Tour telemetry | M5 | not implemented, spec only (§8) |

The format is deliberate: **no wizard or screen takeover**. There is no dimming, and the screen stays interactive. You can scroll, click the interface, open a file and come back. This follows the same rule as the rest of the product: a scrollable document instead of a step-by-step wizard.

---

## 1. Card anatomy

```
┌─ 350px ──────────────────────────────────┐
│ 04 / 08   HOW SHERPA WORKS               │  counter + kicker
│                                          │
│ Progress counts two different things     │  title, ≤2 lines
│                                          │
│ The counter says where you are; the      │  body, 2–3 lines
│ viewed marks say what you actually read. │
│                                          │
│ Skip tour            [ Back ] [ Next ]   │  footer
└──────────────────────────────────────────┘
        ▲ 9×9 pointer, centred on the highlighted target
```

| Element | Spec |
|---|---|
| Container | width **350**, padding `14px 16px 15px`, radius **12**, bg `#171a1f`, border `1px solid #313640`, shadow `0 20px 52px rgba(0,0,0,.62)`, z-index **89** |
| Pointer | 9×9, `transform:rotate(45deg)`, bg `#171a1f`, two `1px solid #313640` borders on the side facing the target. Offset is calculated from the target's centre and stays at least 14px from the card's corners |
| Counter | 10px mono `#8f9bff`, format `04 / 08` (both parts with a leading zero) |
| Kicker | 9.5px mono `#5e636b`, letter-spacing .07em, text `HOW SHERPA WORKS`, the same on every step |
| Title | 14px/600 `#f0f1f4`, letter-spacing −.012em, line-height 1.34, `text-wrap:pretty` |
| Body | 12.5px/1.6 `#a9aeb7`, `text-wrap:pretty`, **2–3 lines, ≤ ~200 characters** |
| Skip tour | text button 12px `#6b7078`, `border-bottom:1px dashed #3a3f47`. Hover `#9ba1ab` / `#5e636b` |
| Back | ghost, height 28, padding 0 11, border `1px solid #2f333a`, radius 7, `#c7cad1`. Hover bg `#1b1e24` |
| Next | primary, height 28, padding 0 13, bg `#7f8cff`, radius 7, ink `#101223`, 12.5px/600 |
| Ring | target + 5px, `1.5px solid #7f8cff`, radius 11, `box-shadow:0 0 0 3px rgba(127,140,255,.13), 0 0 26px rgba(127,140,255,.16)`, `pointer-events:none`, z-index **88** |
| Movement | `transition: left .18s ease, top .18s ease` on the card and ring |

Not allowed inside the card: lists, links, images, progress dots, a second paragraph, icons. One step carries one idea.

---

## 2. Steps: copy and anchors

The copy is final, the interface is in English. `sel` is the anchor selector in the prototype.

| # | Anchor (`sel`) | Title | Body |
|---|---|---|---|
| 01 | `[data-tour="narrative"]`, the first stop's narrative column | The route decides what you read first | Stops are ordered by how much they can hurt — the heart of the change, then its consequences, then the wiring. You may stop after any of them: the important part is already behind you. |
| 02 | `[data-tour^="fold-"]`, the first low-tier stop fold | Low-risk stops arrive folded | Every stop carries a tier. Low ones start folded, with their line count on the fold — nothing is ever hidden from you silently, and one click opens the code. |
| 03 | `[data-tour="stopdiff"]`, the first stop's diff column | Inside every stop is the real diff | Not a retelling of the code — the diff itself, with comments, viewed marks, search and context expansion. If the route vanished, this would still be your reader. |
| 04 | `[data-tour="progress"]`, the `N / 7 stops viewed` counter | Progress counts two different things | The counter says where you are; the viewed marks say what you actually read. Viewed stops dim and fold, so the page gets shorter as you move. Progress is yours alone. |
| 05 | `[data-tour="presets"]`, the Triage / Full tour toggle | Two orders of the same review | Triage sorts by importance. Full tour follows the reading flow — entry point, definitions, consequences, verification. Same stops, same comments, same marks; only the order changes. |
| 06 | `[data-tour="chat"]`, the agent panel | Ask about the lines in front of you | Select code anywhere and ask. The answer streams in here and stays pinned to those lines as a foldable note — one click turns a note into a comment draft. |
| 07 | `[data-tour="fulldiff"]`, the Full diff tab | The classic reader stays one click away | Full diff shows every file in plain order — nothing reordered or folded by the model. The AI layer moves to the margin instead of disappearing. |
| 08 | `[data-tour="ship"]`, the floating panel of final actions | Nothing reaches the author until you say so | Comments are saved as drafts the moment you write them. This panel counts what is waiting, and Ship or Request changes publishes the batch. Sherpa never posts and never ships for you. |

The order follows the reviewer's path, not the menu structure: **what to read** (01–03) → **how to measure progress** (04) → **how to change the order and ask a question** (05–06) → **the way out** (07) → **finishing** (08). On the last step the primary button is **Start reviewing**, and Back stays.

### Interface state during the steps

The tour **changes nothing on the user's behalf**, with one exception:

| Step | State changes |
|---|---|
| 01–05, 07, 08 | none: does not change the view, preset or filters, or expand folds |
| 06 | opens the agent panel. Closes it again on the transition to 07 |

Step 05 highlights the preset toggle without pressing it. Step 07 highlights the "Full diff" tab without switching views, so the reviewer keeps their place in the route.

---

## 3. Positioning

Measure the anchor with `getBoundingClientRect()`, using `position:fixed` coordinates.

```
pad = 5, gap = 14, W = 350, H = 200 (estimated card height)

ring.l = max(4, r.left − pad)
ring.t = max(−2, r.top − pad)
ring.w = min(r.width + 2·pad − left clipping, vw − ring.l − 4)
ring.h = min(r.height + 2·pad, vh − 24)

side:
  below  if ring.t + ring.h + gap + H < vh − 12      ← default
  above  else if ring.t − gap − H > 12
  right  else if ring.l + ring.w + gap + W < vw − 12
  left   else

below/above: left = clamp(ring.l, 16, vw − W − 16); top = ring.t ± (ring.h + gap | H + gap)
right/left:  left = ring.l + ring.w + gap | max(12, ring.l − gap − W); top = ring.t
always:      top = clamp(top, 14, vh − H − 14)

pointer: below/above → clamp(target centreX − left − 4.5, 14, W − 23)
      right/left  → clamp(target centreY − top  − 4.5, 14, H − 23)
```

`right` works for tall targets (diff column, agent panel), `left` is the last choice. The pointer is required on all four sides and always points at the target, even when the card is pushed against the window edge.

### Scrolling to the target

- **Only** the first measurement of a step triggers scrolling, and only if the target is outside the comfortable zone: `r.top < 150` or `r.top > vh − 180`.
- The scroller is the nearest ancestor with `overflow-y: auto|scroll` and actual scrolling, otherwise `document.scrollingElement`. **No `scrollIntoView`**, as everywhere else in the product.
- Animation: 320 ms, ease-in-out cubic. Target position places the target's top 150px from the viewport top. With `prefers-reduced-motion: reduce`, jump instantly.
- Remeasuring after scrolling must not trigger another scroll (it would recurse).
- Sticky and fixed targets (steps 04–08) never scroll the page.

### Remeasurement and resilience

- Recalculate on `scroll` (with capture), `resize`, `window.load`, `document.fonts.ready`.
- After a step starts, retry until a position is found: **340 / 640 / 1000 / 1600 / 2400 / 3400 ms**, stopping as soon as it succeeds. This handles cold loads: fonts, streamed markup and sticky panels settle after the first frame.

---

## 4. States

| State | Behaviour |
|---|---|
| First step | no Back button, footer: `Skip tour` … `Next` |
| Middle steps | `Skip tour` … `Back` `Next` |
| Last step | `Skip tour` … `Back` `Start reviewing` |
| Target outside the viewport (narrow window, horizontally offscreen) | ring hidden, card centred at the bottom (`left:50%`, `bottom:96px`, above the floating panel), step text reads as written |
| Anchor absent from DOM (filter hid the file, no folds) | same: no ring, card at bottom centre. The step is not skipped |
| Scrolling to the target | card does not redraw until the animation ends (no jitter) |
| Palette open (⌘K) | palette rises to z-index **95** and covers the tour. The tour waits underneath |

The tour **does not block** the interface: the ring's `pointer-events` is `none`, clicks on the highlighted element work and do not close the tour.

---

## 5. When to show it

- **Trigger:** first visit to the UI, when the **first filled stop** is ready. Do not show the tour over the generation skeleton, there is nothing to highlight.
- **Once per user**, not per PR.
- `gen: 'failed'` (validation failed): do not start the tour at all.
- `gen: 'offline'` (agent disconnected): show the tour, **omit step 06**, counter becomes `/ 07`, remaining steps are renumbered.
- If the agent dies **during** the tour, do not retract step 06 if already shown. If it has not been reached, omit it (see §9, question 3).

## 6. Leaving and returning

| Action | Result |
|---|---|
| `Skip tour` | the only "close forever" action: sets the completion flag, the tour no longer appears |
| Completing the tour (`Start reviewing`) | same flag |
| Clicking the interface, clicking outside the card | closes nothing |
| `Esc` | closes the palette, **not** the tour. An accidental Esc must not consume the only showing |
| Closing the tab on step 03 | not completion: the tour resumes from step 03 on the next visit |
| Palette → "Replay the onboarding tour · 8 steps" (`sherpa` group) | resets the flag and starts from 01 |

## 7. Keyboard and accessibility

- `→` / `Enter` go to the next step, `←` goes back. While the palette is open, arrows do not control the tour.
- The card has `role="dialog"` with `aria-modal="false"`: the screen reader reads the step, but focus is not trapped in the card (the tour is non-blocking).
- Focus moves to the card when a step starts. `aria-describedby` points to the step body.
- A live region announces step changes: "step 4 of 8, <title>".
- The highlighted element gets `aria-describedby` pointing to the card, so the "ring ↔ text" connection is audible as well as visible.
- `prefers-reduced-motion: reduce` disables smooth scrolling and card movement.

## 8. Telemetry

| Event | Payload |
|---|---|
| `tour_shown` | trigger (first_run / replay), step count (8 or 7 when offline) |
| `tour_step` | index, title, time on step, whether the target was found (to assess the fallback layout) |
| `tour_skipped` | step index when leaving |
| `tour_completed` | total time |
| `tour_replayed` | source (palette) |

Interpretation: the most frequently skipped step signals that the **copy needs rewriting**, not that the step should be removed. Frequent "target not found" results signal a poorly chosen anchor.

## 9. Questions to settle before implementation

1. **Where to store the completion flag and step number.** The prototype uses `localStorage` (`sherpa.onboarding.v1`, `sherpa.onboarding.step`). Product choice: per-user local Sherpa state on disk (survives a browser change, lost on reinstall) or a browser session. A choice is needed.
2. **Second pass.** Does the "what changed since last time" banner (F3) need its own small tip, or is that explaining the banner rather than onboarding?
3. **Agent dies during the tour.** Continue without step 06 or show it with reconnection text?
4. **Narrow windows.** The page is designed for ≥1440px. At 1280 some anchors (viewed counter, agent panel) go offscreen and the step uses the fallback layout. If 1280 is a real use case, these two steps need alternative anchors.

## 10. Acceptance checklist

- [ ] The tour starts once, after the first stop is ready, and does not start on `failed`.
- [ ] Eight steps follow the order in §2 with the exact copy. The last primary button is `Start reviewing`.
- [ ] The ring outlines the element the step describes, and the pointer points to its centre on all four sides, including when the card is against the window edge.
- [ ] A scrolling step (01–03) reaches the target and outlines it. Remeasuring does not trigger a second scroll.
- [ ] Cold load: the card gets a position without user action (remeasurement retries).
- [ ] Step 06 opens the agent panel and closes it on step 07. No other step changes state.
- [ ] Offline: step 06 is omitted, counter `/ 07`.
- [ ] Target offscreen or missing: ring hidden, card at bottom centre, step readable.
- [ ] Clicking the interface and Esc do not close the tour. `Skip tour` closes it forever.
- [ ] An unfinished tour resumes from the same step after reload.
- [ ] The palette covers the tour. The "Replay the onboarding tour" command resets the flag and starts from 01.
- [ ] `→ / Enter / ←` work. A live region announces step changes. `prefers-reduced-motion` removes animations.
- [ ] The five telemetry events in §8 are sent with the specified payloads.
