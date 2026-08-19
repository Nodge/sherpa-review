# Sherpa: v1 implementation specification

**v1.0 · 19.08.2026 · for the development team**

## 0. Source documents

This specification connects four documents and adds what they lack: milestones, contracts, decisions on open questions and testing requirements. It **does not duplicate** the sources. Read them all.

| Document | Role | Contents |
|---|---|---|
| `sherpa-brief.md` (v0.11) | product source of truth | problem, principles 1–7, scenarios F1–F5, MUST/SHOULD, out of scope, host adapters |
| `rpc-design.md` | session↔server protocol | pull model, CLI contract, lease queue, heartbeat, discovery, security |
| `design/design_handoff_sherpa/README.md` | UI source of truth: screens | 15 states, tokens, layouts, copy |
| `design/design_handoff_sherpa/SPEC-elements.md` | UI source of truth: behaviour | state matrix, edge cases, keyboard (§5), a11y (§6), acceptance (§8) |
| `research/*.md` | context | reasons for decisions, read when asking "why this way" |

Priority in a conflict: brief (product principles) → SPEC-elements → README → prototype. The `Sherpa.dc.html` prototype is a reference, not source code. The SCENARIOS button is not implemented.

## 1. System components

```
C1 Skill + CLI ──(pull, rpc-design)── C2 Local server ──(REST+WS)── C3 Web UI
                                          │        │
                                  C4 Host adapters  C5 Generation pipeline
                                  (review host, GitHub)  (prompts + schemas + validator)
```

**C1. Skill + CLI `sherpa`.** A skill for harnesses (Claude Code first, using a universal SKILL.md + worker instructions). The CLI is TypeScript bundled by esbuild into **one self-contained `.mjs`** (Node ≥ 20, built-in fetch, zero external runtime dependencies), included in the skill package. Commands and semantics: rpc-design §3. Contract types and JSON schemas share a package with C2.

**C2. Local server.** Node/TS. One process per PR (rpc-design §11.2, decided: per-PR). Handles REST+WebSocket for the UI, a task queue with leases/priorities/heartbeat (rpc-design §5, §7), fail-closed validation of generation results, route snapshots, polling/reading the host through an adapter and storage. **Storage is SQLite** (better-sqlite3), a per-PR file in `~/.sherpa/prs/<host>-<pr>/`: queue, snapshots, progress (viewed/seen ranges), notes, chat history, feedback drafts. Discovery manifest and token: rpc-design §8.

**C3. Web UI.** React + TS, a pnpm workspace with C2. Implements all 15 handoff states. Diff and file tree virtualization is mandatory from the first screen (SPEC §8 item 8: 60+ files at 60fps). State lives outside the React tree (store + `useSyncExternalStore`), diffs are parsed in workers.

**C4. Host adapters.** One interface, two implementations. Start with **the review host in M1**, then **GitHub in M6**. The interface is fixed in M1, and no host-specific concepts pass above it (brief §4a). Minimum interface:

```ts
interface ReviewHost {
  getPr(): PrMeta;                    // title, author, branches, head
  getDiff(base, head): FileDiff[];    // + generated marking
  watchThreads(cb): Unsubscribe;      // reactive updates or polling (GitHub)
  saveDraft(c: CommentDraft): Id;     // immediately, two-stage model
  publishBatch(verdict: Verdict): PublishResult; // ship | sticky_ship | request_changes (+ approve for GitHub)
  setFileViewed?(path, bool);         // if the host supports it (GitHub does)
  ownershipLens(): Lens | null;       // CODEOWNERS
  extraLenses(): Lens[];              // PCI DSS, host-specific
}
```

**C5. Generation pipeline.** Task prompts `route.skeleton`, `route.section`, `chat`, `regenerate.*` + result JSON schemas + validator. Prompt rules: importance order, research budget, voice, coverage rule. Validator rules: brief ("Route" glossary) + SPEC §4.3. UI stop schema: handoff README, State model section.

## 2. Technology overview

pnpm monorepo: `packages/{protocol,server,ui,cli,skill}`. TS throughout. Node ≥ 20. SQLite. No Docker or external services: the entire product runs on the reviewer's machine. IBM Plex Sans/Mono fonts are vendored locally (no Google Fonts, the UI must work on an isolated network).

## 3. Decisions on open questions

Question sources: the handoff README ("Open questions", 4 items) and rpc-design §11.

1. **A "seen line" comes only from manual marks, with no viewport tracking** (product owner's decision, supersedes the IntersectionObserver option). A file's seen ranges = the union of ranges covered by stops the reviewer manually marked viewed, plus manually marked files. The designers' tri-state follows without tracking: a stop covers all changed lines in a file → `read`, part → `partial`, nothing marked → `unread` (the rule in SPEC §2.10). The "24 of 60 lines seen" tooltip and Review complete counters use the same manual marks. Passive scrolling has no effect.
2. **File filter and stops**: follow the design, hide stops with no matching files, with the "kept in view" safeguard (SPEC §2.7). Numbers are fixed by the plan.
3. **Keyboard**: the full SPEC §5 map, one shortcut registry → generate the palette and shortcuts sheet from it.
4. **Reply thread depth**: follow the design (indent cap = 4, then "↳ replying to"). In M1, check real review host threads with depth > 6.
5. **RPC**: per-PR server, SQLite, task payloads as markdown files, schema only for the result, `complete` result limit of 256 KB (larger → task fails with a clear error), context files truncated to budget with an explicit "truncated" marker in the payload.
6. **"Small PR" threshold** (ratifies the designers' finding, SPEC §4.1): no route generation if changed lines ≤ 40 or files ≤ 1. The UI opens on the full diff with a notice. The threshold is configurable.
7. **Also ratified**: promote "Other" when >40% is not placed + offer regeneration (SPEC §4.3), generated files start as `read` (SPEC §2.12), a second worker for a PR is rejected with a message (SPEC §4.4, consistent with rpc-design).

## 4. Milestones and Definition of Done

Each milestone ends with dogfooding on a real PR. Alice Ingram does the dogfooding. Milestones M1–M4 are sequential by value, but C1/C2/C3 can run in parallel within them.

**M0: Loop (foundation, ~1–2 weeks).**
Skill + CLI + server skeleton + queue + manifest/tokens. One dummy task (echo). Run in **two harnesses** (Claude Code, Codex): confirm long-poll survives harness timeouts, heartbeat, session death/reconnection and lease recovery.
*DoD: demo "skill launched → UI opened → task passed through the loop → session killed → UI showed 'Agent disconnected' → reconnection".* This is the project's main technical risk, so resolve it first.

**M1: Reader + review host (a complete product without AI).**
Full diff: file tree, unified/split, viewed/partial/read, context expansion, lens filters (CODEOWNERS, PCI DSS, generated), search, palette (at minimum: go to file, search). Reactive review host threads, two-stage drafts, floating panel, ship/sticky ship/request changes, Review complete screen. "No route yet" states.
*DoD: the brief's full F5 scenario. Alice Ingram performs a real review in Sherpa without the AI layer and ships it. SPEC §8 checklist for the implemented screens.*

**M2: Route.**
C5: skeleton+sections, validator, snapshot with provenance. UI: Route triage + Full tour, coverage strip, tiers, collapsed low, "Other", test digest, Overview phases A/B, partially filled route, Generation failed with raw output.
*DoD: full F1 on a real PR with ≥ 15 files. Golden tests cover the validator (valid/broken model outputs). Generation ≤ 90 s p50 on an ~800-line PR (measure it, this is the first quality-of-life benchmark).*

**M3: Chat and notes.**
Chat column, selection popover, pinned agent notes, "Turn into a comment draft", queue with accurate states, Ask AI.
*DoD: full F2. A question asked during route generation queues correctly, and the UI shows it.*

**M4: Iterations (the main differentiator).**
Snapshots + stale banner, progress carryover (stops with unchanged ranges stay viewed), "what is new since the previous pass" filter, "why this stop changed", base/snapshot selection, comments pinned to an old commit.
*DoD: full F3: the author pushes → the reviewer sees "what is new", progress is preserved. A force-push test.*

**M5: Polish for v1.**
Full keyboard support + shortcuts sheet, a11y (SPEC §6), reduced motion, virtualization at 60fps on a synthetic PR with 100 files / 20k lines, telemetry (SPEC §7), feedback channel, limits and reduced functionality (SPEC §3, §4.1), comment edge cases (SPEC §4.5).
*DoD: SPEC §8 acceptance checklist for all screens. One week of dogfooding with ≥ 3 reviewers.*

**M6: GitHub adapter.**
A second `ReviewHost` implementation: CODEOWNERS lens, pending review, polling, viewed synchronization, approve/request changes. Interface contract tests run against both implementations.
*DoD: F1+F3 on a real GitHub PR. The brief's §4a differences table is confirmed or revised.*

## 5. Contracts

- **C1↔C2 protocol**: rpc-design §3–§5. Protocol version in the handshake. Incompatibility produces a human-readable error.
- **Route snapshot schema**: based on the handoff README (State model). The canonical version lives in `packages/protocol` (zod) and generates JSON schemas for C5. Rule: **the UI consumes nothing that has not passed the validator.**
- **`ReviewHost`**: §1/C4. Host concepts stay inside the adapter.
- **UI state**: per-session and per-PR sections from the README (State model). Per-PR in SQLite through C2, per-session in tab memory + URL (the filter goes in the URL, SPEC §2.7).

## 6. Non-functional requirements

- **Performance:** diff on screen < 2 s after opening the UI (the route catches up asynchronously, the "nothing waits for the agent" principle). Scrolling at 60fps on a 100-file PR. Rendering limits: SPEC §2.13 (files > 2000 lines are collapsed), §3 (skeleton timing).
- **Security:** everything on localhost, bearer token on every channel including the UI, manifest/token files 0600, no accepting external connections.
- **Reliability:** the server survives worker termination, the UI survives server termination (reconnect banner), drafts are never lost (SQLite + "not saved · retry", SPEC §4.5).
- **Telemetry**: SPEC §7, internal, from day one of M5. Events carry a snapshot ID to correlate with generation quality.

## 7. Testing

- **Validator golden tests** (M2): a corpus of real and synthetically corrupted model outputs → deterministic validation results. Every "model returned something strange" incident adds to the corpus.
- **`ReviewHost` contract tests**: one test suite for both implementations (review host on mocks recorded against staging, GitHub on a test repo).
- **C1↔C2 protocol tests with a fake worker**: a script emulating a session (including: died silently, returned garbage, repeated complete, exceeded the lease). Real harnesses are tested manually in M0 and every release.
- **E2E (Playwright) for scenarios F1–F5**: one end-to-end test per scenario, on a fixture PR.
- **Performance run** on a synthetic large PR in CI with a frame-time budget.
- Generation is **not** tested in CI against a live model. Route quality uses telemetry + 👍/👎 + weekly manual review.

## 8. Risks

| Risk | Mitigation |
|---|---|
| Harness timeouts/loop behaviour in real harnesses | M0 first. Manual harness matrix for every release |
| Review host API capabilities (reactive threads, drafts, sticky ship) fall short of expectations | Spike in the first days of M1: check each `ReviewHost` operation against the real API before fixing the interface |
| Generation latency kills the value | Measure in M2 (DoD), research budget in prompts, warm up on skill launch. CI prebuild in v2/v3 |
| Route quality (hallucinations in overview) | The validator checks structure. Text accuracy relies on provenance + 👍/👎 + "check in one click" anchors. Honestly, there is no technical solution, see brief principle 2 |
| SQLite contention (UI+polling+worker) | One owner process (C2), WAL, all writes go through it |

## 9. Out of scope for v1

See brief §10 (current revision v0.11): inbox, its own AI review, author mode, difftastic/structural diff (except a reserved spot for a "formatting only" badge), CI prebuild, diagrams as a guaranteed artifact, mobile layout, multiple workers.
