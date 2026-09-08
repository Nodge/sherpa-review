# Structural/semantic diff: difftastic and alternatives

> Research dated 2026-08-18. Facts come from difftastic source (`src/display/json.rs`, `src/options.rs`), issues and discussions. No hands-on measurements (the binary is not installed). Two intended uses: (A) input for the AI agent when building a route, (B) a display for the reviewer in the full diff.

## Brief conclusion

**(A) difftastic does not fit as agent input.** Its JSON lacks the facts that would justify using it: no "function moved", no "argument added", no AST node types or symbol names. It only has changed-token coordinates with a highlighting class. Exactly one thing is useful: `difft --check-only --exit-code`, a cheap answer to "is this a syntactic change or just reformatting?". For (A), use a custom tree-sitter layer (intersect hunks with symbol ranges) or the existing `sem` tool.

**(B) difftastic works for human presentation. That is what it was built for.** JSON provides `aligned_lines` (before/after line correspondence across the whole file) plus exact column ranges for changed tokens. Integration costs little, but needs serious safeguards (below).

**The main risk:** difftastic can silently report "no changes" where changes exist (#587, open since 2023), in indentation-sensitive languages (Python, F#). Its verdict cannot be the sole source of truth.

## 1. How difftastic works

- tree-sitter → simplified "atom/list" tree → **Dijkstra over a graph of position pairs** (an idea from Autochrome). difftastic stores neither whitespace nor position, so reformatting does not count as a change.
- The graph is O(L×R), exponential in nesting depth. The workaround of "≤2 vertices per position pair" means the route is not necessarily shortest (the author's admission). A* did not work out (PR #1007: no suitable metric).
- **Detects:** reformatting, added wrappers, insignificant trailing punctuation (since 0.69), word-level changes. **Does not detect moves or renames** due to its architecture (issues #508, #520, #999 have been open for years). It ignores blank lines. Popular articles claiming move/rename support are wrong (they look generated).
- Languages: ~70 + 10 formats (0.69–0.71 removed Hack, Elvish, SCSS and Hare because upstream grammars were abandoned. Coverage is not constant).
- Their "Tricky Cases" is worth reading: moving a node between nesting levels, sliders, replacing an entire function (a mess of false matches), edits inside a long string atom.

## 2. JSON output (for (B))

Added in 0.51.0. **Still requires `DFT_UNSTABLE=yes`** and remains undocumented. Schema (from `json.rs`):

```jsonc
{ "aligned_lines": [[0,0],[1,1],[2,null],...],   // LHS↔RHS line correspondence, only added in 0.70 (Aug 2026)!
  "chunks": [[{ "lhs": {"line_number":12,"changes":[{"start":5,"end":9,"content":"gsub","highlight":"normal"}]},
                "rhs": {...} }]],
  "language": "TypeScript",   // or "Text (exceeded DFT_GRAPH_LIMIT)", free text, not an enum!
  "path": "src/foo.ts", "status": "changed|unchanged|created|deleted" }
```

Gotchas: `highlight` is a highlighting class, not AST. JSON loses the NovelWord/NovelLinePart distinction (#658, so their highlighting cannot be reproduced exactly). `--context` is ignored (read context from blobs ourselves). There is no old-side path or file rename information (get it from `git diff --raw -M`). The format is NDJSON per file, not an array (#916). Chunk order was nondeterministic until 11.2024.

## 3. Performance and trust

Limits: `DFT_BYTE_LIMIT` 1 MB, `DFT_GRAPH_LIMIT` 3M vertices, `DFT_PARSE_ERROR_LIMIT` **0**. Exceeding any of them triggers a **silent fallback to a line-by-line diff** (indicated only in `language`). Actual figures from issues: pnpm-lock 13 s/9 GiB (fixed later), a 500 KB jest snapshot >70 s, composer.lock consumes 64 GB (#373 open since 2022). The author says >100 MiB RAM is normal for ordinary programs. In one user's C project, 88 of 90 fragments fell back to a text diff (preprocessor + error limit of 0).

**Three things that break trust:**
1. Silent fallback (see above). Consumers must check `language` for the `Text (` prefix.
2. **False "No syntactic changes"** on a real change (#587, Python/F#, unfixed since 2023): diff logic sees the change, display logic does not if every token found a match. Do not build "unchanged → hide/omit from agent input" without cross-checking against the text diff.
3. Missing highlighting on repeated content (an import path change is highlighted in the wrong place).

## 4. Integration

- MIT, no licensing concerns. **No library exists, and none is planned for the foreseeable future** (#216 since 2022. The author's position in 10.2025: show real JSON consumers first). JSON is the only interface and is marked unstable, so pin a version (0.70+ for `aligned_lines`), validate its schema and use golden tests.
- No WASM (#407, #927), so server-side only. Binaries exist for all platforms.
- Call it directly on 2 temporary files, not through git diff.external (git ≤2.43.1 fails on permissions, and a direct call has fewer surprises).
- **Hygiene:** anything parsing unified diff must call `git diff --no-ext-diff` (the Git Extensions gotcha, critical).

## 5. Alternatives

| Tool | Move | Rename | Granularity | JSON | License |
|---|---|---|---|---|---|
| RefactoringMiner | ✅ | ✅ | method/class/field/variable | ✅ | MIT |
| GumTree | ✅ | ✅ | AST node | ✅ | LGPL-3.0 |
| **sem** | ✅ | ✅ | entity | ✅ stable | Apache-2.0 |
| SemanticDiff | within a file | ✅ | block | ❌ | proprietary |
| git --color-moved | ✅ (blocks) | ❌ | line | ❌ ANSI | GPL |
| difftastic | ❌ | ❌ | — | ⚠️ unstable | MIT |
| diffsitter | ❌ | ❌ | — | ⚠️ undocumented | MIT |

- **diffsitter** is out. Despite the name, it does not match trees (Myers over a flat list of leaves). Released Apr 2025, "nowhere close to production ready", 737 seconds for an 8 MB file.
- **GumTree** is the only mainstream tool with a real edit script (insert/delete/update/**move**) in JSON. v4 uses tree-sitter, 23 languages. But it needs a JVM, uses LGPL, the stable release is from 2021, and v4 has been in beta for 3 years.
- **RefactoringMiner** is MIT, active, with 106 refactoring types, Java/Python/Kotlin/TS/JS. The best answer to "this is a rename, not delete+add" if needed.
- **mergiraf** is GumTree classic in Rust, but it is a merge driver with no diff API, GPL-3.0. Relevant only for "what about merging?".
- **sem** (Ataraxy-Labs, Apache-2.0, 3.3k stars, created 02.2026, active): entity-level diff over git, tree-sitter, 28–32 languages. Three-level matching (id → structural hash → fuzzy >80%) produces added/modified/deleted/**moved/renamed**/reordered for functions/classes/methods, with stable JSON. Also `sem impact` (blast radius), `sem context` (context within a token budget), MCP. Caveats: 0.x, the project is half a year old. Disable telemetry (`SEM_NO_TELEMETRY=1`) and cloud (`SEM_LOCAL=1`). Do not run `sem setup` (it edits `~/.claude/settings.json` and replaces git diff). Call the binary directly.
- **rinkaku** (MIT, 40 stars): Added / SignatureChanged / body-only taxonomy plus fan-in for production symbols, exactly the summary shape the agent needs. Its core is an embeddable library.
- **github/semantic** is dead (archived 04.2025, diff died in 2020). stack-graphs is archived too.

## 6. Design observations

- Grouping changes into cohorts → layers → line ranges matches our route. **The "Semantic" mode is a presentation layer** (announced 21.05.2026), with no disclosed mechanism.
- The model receives the **ordinary diff from the PR payload, unchanged** (CEO podcast, 06.2025). The structural part is context, not a diff: a symbol graph built for each review, plus an agent with shell commands. Public PRs show "Code Graph Analysis", full symbol definitions with ranges, and "Analysis chain", mostly `rg`/`sed`/`head`/`git`, occasionally `ast-grep` (`ast-grep outline --json` gives a file's symbol table, plus YAML rules for custom checks).
- For (A), there is no diff mechanism to copy here. The useful parts are mixing in symbol definitions with ranges and the agent loop.

## 7. Empirical evidence for (A) is sobering

- **SWE-PRBench** (03.2026, preprint): 8 models get steadily worse when AST-extracted context is added to the diff (Sonnet 4.6: 0.190 → 0.122). Attention gets diluted.
- **ContextCRBench** (ICSE 2026, 68k records): F1 gain from the issue description +59.8%, PR description +72.2%, both +78.4%. Code context is the weak part. **Intent matters several times more than structure.**
- **Diff-XYZ** (JetBrains, 10.2025): diff format matters (search-replace 0.95 vs udiff 0.76 EM), line numbers provide a framework. But the comparison included no structural formats.
- There are no studies of "AST edit script vs unified diff for review quality". Qodo PR-Agent (12.6k stars) uses no AST at all. Its format: `__new hunk__` with absolute line numbers in the new file + `__old hunk__` without numbers, 5 lines of context before / 1 after.

## 8. User experience (HN, issues)

Helps with reformatting, wrappers (git picks the wrong boundary), **real line numbers instead of @@ headers** (users call this useful on its own), large refactorings and configs. Frustrations: speed ("too slow as the default"), no background fill for changed lines (#541, the main readability complaint, so we would have to draw it ourselves), column widths change between files (#861), hidden whitespace changes led to junk commits (#657), trust in tree-sitter grammars (an approximation, not a compiler parser). The author recommends calling it selectively, rather than making it the default. Unsuitable for patches by design (it can find + and − on the same line, issues #806 and #838 closed as out of scope).

## 9. Recommendations

1. **Measure on our repository first** (20–30 real PRs: text fallback rate, p95 time/memory, share of formatting-only files). Published figures differ by orders of magnitude.
2. **(B): use difftastic** with wiring: pinned version ≥0.70, `DFT_UNSTABLE`, schema validator, explicit `DFT_BYTE_LIMIT`/`DFT_GRAPH_LIMIT`/`DFT_PARSE_ERROR_LIMIT≈20`, external timeout, exclusions for locks/snapshots/generated files. **Always cross-check against the text diff** (nonempty text diff + difftastic "unchanged" = "structural diff failed", show the ordinary view with a notice, not "formatting only"). Check `language` for `Text (`. Add moves and changed-line fills in our own layer (git --color-moved + VS Code's moved-blocks algorithm, which is open and simple).
3. **(A): do not use it**, except `difft --check-only` as a "formatting only" filter (with the same cross-check). Build our own "hunks × symbols" layer on tree-sitter (~200 lines: `git diff -U0` + `ast-grep outline --json`/tags.scm + range intersections) → "changed: `AuthService.validateToken` (body), `parseConfig` (signature)". Or use `sem` after checking it against our stack. Model diff format should follow PR-Agent.
4. **Do not overrate structure in (A):** the PR description, issue and reading order give the agent several times more. The structural layer is useful for removing noise. The model already infers structure from text.
5. Run our own experiment (absent from the literature): same PRs / model / prompt, unified diff vs collapsed formatting + marked moves. Metric: recall on PRs with known defects.

## Addendum: Reddit corpus (received separately)

The discussion volume is smaller than the reputation suggests (~15 substantive threads). Consensus: difftastic is a **read-only tool used selectively**, with delta alongside it, not a replacement. Three recurring complaints with supporting reports: memory on large files (gigabytes, users switch back to delta), inability to produce a patch (breaks magit and `git add -p`, users converge on an alias for `git diff --no-ext-diff`), side-by-side in narrow windows (~35 characters per column is unreadable, width is not recalculated on resize). The only correctness complaint with a reproduction: **reordering 2 methods in a class appears as a full delete+insert**, exactly the gap that competitors from 2024–2026 start with (SemanticDiff, diffmantic.nvim, sem). Also confirmed: difftastic's author admits diffsitter is faster. Dijkstra is the bottleneck (65% of time in hashmaps, O(N²) memory).

A relevant observation from an adjacent discussion: in the r/golang thread "how do you review large AI diffs", difftastic is never mentioned. The top replies are "split PRs" (168 votes) and "read tests first". One person asks for exactly our tool ("separate renames/moves from behavioral changes"). And sem has a useful positioning line: "difftastic makes the diff readable, sem makes it queryable".

## Unverified

No hands-on measurements (installing difftastic requires permission). Reddit is unavailable. The "Semantic" mode's mechanism is undisclosed. The diffsitter JSON schema was inferred from code and not checked by running it. SemanticDiff on-prem is "contact us" only.
