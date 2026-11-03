# Structural/semantic diff: difftastic and alternatives

> Research dated 2026-08-18. The facts come from the difftastic source (`src/display/json.rs`, `src/options.rs`), its repository issues and discussions. There are no hands-on measurements, because the binary is not installed. The research covers two target uses: (A) input for the AI agent building a route, and (B) presentation for a person in the full diff.

## Brief conclusion

**(A) difftastic does not fit as agent input.** Its JSON lacks the facts that would justify using it. It reports nothing like "function moved" or "argument added", and it has no AST node types or symbol names. It only has changed-token coordinates with a highlighting class. Exactly one feature is useful: `difft --check-only --exit-code` gives a cheap answer to "is this a syntactic change or just reformatting?". For (A), use a custom tree-sitter layer that intersects hunks with symbol ranges, or the existing `sem` tool.

**(B) difftastic works for human presentation. That is what it was built for.** Its JSON provides `aligned_lines`, the before/after line correspondence across the whole file, plus exact column ranges for changed tokens. Integration costs little but needs serious safeguards, described below.

**The main risk:** in indentation-sensitive languages such as Python and F#, difftastic can silently report "no changes" where changes exist (#587, open since 2023). Its verdict therefore cannot be the sole source of truth.

## 1. How difftastic works

- difftastic parses both sides with tree-sitter, turns the result into a simplified "atom/list" tree and runs **Dijkstra over a graph of position pairs** (an idea from Autochrome). difftastic stores neither whitespace nor position, so reformatting does not count as a change.
- The graph is O(L×R) and grows exponentially with nesting depth. The workaround allows "≤2 vertices per position pair", so the route it finds is not necessarily the shortest, as the author admits. A* did not work out because there was no suitable metric (PR #1007).
- **It detects** reformatting, added wrappers, insignificant trailing punctuation (since 0.69) and word-level changes. **It does not detect moves or renames**, because its architecture does not allow it (issues #508, #520 and #999 have been open for years). It ignores blank lines. Popular articles that claim move and rename support are wrong, and they look generated.
- difftastic supports ~70 languages and 10 formats. Coverage is not constant: 0.69–0.71 removed Hack, Elvish, SCSS and Hare because their upstream grammars were abandoned.
- difftastic's "Tricky Cases" write-up is worth reading. It covers moving a node between nesting levels, sliders, replacing an entire function (which produces a mess of false matches) and edits inside a long string atom.

## 2. JSON output (for (B))

JSON output was added in 0.51.0. It **still requires `DFT_UNSTABLE=yes`** and remains undocumented. The schema, taken from `json.rs`, looks like this:

```jsonc
{ "aligned_lines": [[0,0],[1,1],[2,null],...],   // LHS↔RHS line correspondence, only added in 0.70 (Aug 2026)!
  "chunks": [[{ "lhs": {"line_number":12,"changes":[{"start":5,"end":9,"content":"gsub","highlight":"normal"}]},
                "rhs": {...} }]],
  "language": "TypeScript",   // or "Text (exceeded DFT_GRAPH_LIMIT)", free text, not an enum!
  "path": "src/foo.ts", "status": "changed|unchanged|created|deleted" }
```

The schema has several gotchas. `highlight` is a highlighting class and carries no AST information. The JSON loses the NovelWord/NovelLinePart distinction (#658), so difftastic's own highlighting cannot be reproduced exactly. `--context` is ignored, so the integration has to read context from the blobs itself. The output has no old-side path and no file rename information, which have to come from `git diff --raw -M`. The format is NDJSON with one object per file rather than an array (#916). Chunk order was nondeterministic until 11.2024.

## 3. Performance and trust

difftastic has three limits: `DFT_BYTE_LIMIT` at 1 MB, `DFT_GRAPH_LIMIT` at 3M vertices and `DFT_PARSE_ERROR_LIMIT` at **0**. Exceeding any of them causes a **silent fallback to a line diff**, which only the `language` field marks. Issues report actual figures: pnpm-lock took 13 s and 9 GiB (later fixed), a 500 KB jest snapshot took >70 s, and composer.lock consumes 64 GB (#373, open since 2022). The author says that >100 MiB of RAM on ordinary programs is normal. In one user's C project, 88 of 90 fragments fell back to a text diff because the preprocessor met the error limit of 0.

**Three things break trust:**
1. Silent fallback, described above. Consumers must check `language` for the `Text (` prefix.
2. **A false "No syntactic changes"** on a real change (#587, Python/F#, unfixed since 2023). The diff logic sees the change, but the display logic does not if every token found a match. A rule such as "unchanged, so hide it or omit it from agent input" must not be built without a cross-check against the text diff.
3. Highlighting goes missing on repeated content. For example, an import path change is highlighted in the wrong place.

## 4. Integration

- difftastic is MIT, so licensing raises no concerns. **No library exists, and none is planned for the foreseeable future** (#216, open since 2022). In 10.2025 the author's position was that someone should show real JSON consumers first. JSON is the only interface and is marked unstable, so an integration has to pin a version (0.70+ for `aligned_lines`), validate the schema and use golden tests.
- There is no WASM build (#407, #927), so difftastic can run server-side only. Binaries exist for all platforms.
- The integration should call difftastic directly on 2 temporary files rather than through git diff.external. git ≤2.43.1 fails on permissions with diff.external, and a direct call has fewer surprises.
- **Hygiene:** anything that parses unified diff must call `git diff --no-ext-diff`. This is the Git Extensions gotcha, and it is critical.

## 5. Alternatives

| Tool | Move | Rename | Granularity | JSON | License |
|---|---|---|---|---|---|
| RefactoringMiner | yes | yes | method/class/field/variable | yes | MIT |
| GumTree | yes | yes | AST node | yes | LGPL-3.0 |
| **sem** | yes | yes | entity | yes, stable | Apache-2.0 |
| SemanticDiff | within a file | yes | block | no | proprietary |
| git --color-moved | yes (blocks) | no | line | no (ANSI) | GPL |
| difftastic | no | no | — | unstable | MIT |
| diffsitter | no | no | — | undocumented | MIT |

- **diffsitter** is out. Despite the name, it does not match trees (it runs Myers over a flat list of leaves). It was released in Apr 2025 and is described as "nowhere close to production ready". It took 737 seconds on an 8 MB file.
- **GumTree** is the only mainstream tool with a real edit script (insert/delete/update/**move**) in JSON. v4 uses tree-sitter and supports 23 languages. On the other hand, GumTree needs a JVM and uses LGPL, its stable release is from 2021, and v4 has been in beta for 3 years.
- **RefactoringMiner** is MIT and active, with 106 refactoring types for Java/Python/Kotlin/TS/JS. It is the best answer to "this is a rename, not delete+add", if that is ever needed.
- **mergiraf** is GumTree classic in Rust, but it is a merge driver with no diff API, under GPL-3.0. It matters only for the question "what about merging?".
- **sem** (Ataraxy-Labs, Apache-2.0, 3.3k stars, created 02.2026, active) builds an entity-level diff over git with tree-sitter and supports 28–32 languages. Its three-level matching (id, then structural hash, then fuzzy >80%) produces added/modified/deleted/**moved/renamed**/reordered for functions/classes/methods, with stable JSON. sem also offers `sem impact` (blast radius), `sem context` (context within a token budget) and MCP. The caveats are that it is 0.x and the project is half a year old. An integration must disable telemetry (`SEM_NO_TELEMETRY=1`) and cloud (`SEM_LOCAL=1`) and must not run `sem setup`, because that command edits `~/.claude/settings.json` and replaces git diff. The integration calls the binary directly.
- **rinkaku** (MIT, 40 stars) has an Added / SignatureChanged / body-only taxonomy plus fan-in for production symbols, which is exactly the summary shape the agent needs. Its core is an embeddable library.
- **github/semantic** is dead: it was archived in 04.2025, and its diff died in 2020. stack-graphs is archived too.

## 6. Design observations

- Grouping changes into cohorts, then layers, then line ranges matches our route. **The "Semantic" mode is a presentation layer** (announced 21.05.2026), and its mechanism is not disclosed.
- The model receives the **ordinary diff from the PR payload, unchanged** (CEO podcast, 06.2025). The structural part is context rather than a diff: a symbol graph built for each review, plus an agent with shell commands. Public PRs show "Code Graph Analysis", with full symbol definitions and their ranges, and "Analysis chain", which is mostly `rg`/`sed`/`head`/`git` and occasionally `ast-grep`. In `ast-grep`, `ast-grep outline --json` gives a file's symbol table, and YAML rules add custom checks.
- For (A), there is no diff mechanism to copy here. The useful parts are mixing in symbol definitions with ranges and the agent loop.

## 7. Empirical evidence for (A) is sobering

- In **SWE-PRBench** (03.2026, preprint), 8 models get steadily worse when AST-extracted context is added to the diff. Sonnet 4.6, for example, drops from 0.190 to 0.122. The extra context dilutes attention.
- In **ContextCRBench** (ICSE 2026, 68k records), the issue description raises F1 by +59.8%, the PR description by +72.2%, and both together by +78.4%. Code context is the weak part. **Intent matters several times more than structure.**
- **Diff-XYZ** (JetBrains, 10.2025) shows that diff format matters (search-replace 0.95 vs udiff 0.76 EM) and that line numbers provide a framework. The comparison included no structural formats, though.
- No study compares "AST edit script vs unified diff for review quality". Qodo PR-Agent (12.6k stars) uses no AST at all. Its format has a `__new hunk__` with absolute line numbers in the new file and an `__old hunk__` without numbers, with 5 lines of context before and 1 after.

## 8. User experience (HN, issues)

Users say difftastic helps with reformatting, wrappers (where git picks the wrong boundary), **real line numbers instead of @@ headers** (users call this useful on its own), large refactorings and configs.

The first frustration is speed ("too slow as the default"). The main readability complaint is the missing background fill for changed lines (#541), so we would have to draw the fill ourselves. Column widths change between files (#861), hidden whitespace changes led to junk commits (#657), and users question trust in tree-sitter grammars, which are an approximation rather than a compiler's parser. The author recommends calling difftastic selectively rather than making it the default. It is unsuitable for patches by design, because it can find + and − on the same line (issues #806 and #838 were closed as out of scope).

## 9. Recommendations

1. **Measure on our repository first.** Take 20–30 real PRs and record the text fallback rate, p95 time/memory and the share of formatting-only files. Published figures differ by orders of magnitude.
2. **(B): use difftastic** with wiring: a pinned version ≥0.70, `DFT_UNSTABLE`, a schema validator, explicit `DFT_BYTE_LIMIT`/`DFT_GRAPH_LIMIT`/`DFT_PARSE_ERROR_LIMIT≈20`, an external timeout, and exclusions for locks/snapshots/generated files. **Always cross-check against the text diff.** A nonempty text diff together with a difftastic "unchanged" means "structural diff failed", and the view should then be the ordinary one with a notice instead of "formatting only". Check `language` for `Text (`. Add moves and changed-line fills in our own layer, using git --color-moved and VS Code's moved-blocks algorithm, which is open and simple.
3. **(A): do not use it**, except for `difft --check-only` as a "formatting only" filter with the same cross-check. Build our own "hunks × symbols" layer on tree-sitter, ~200 lines of `git diff -U0` plus `ast-grep outline --json`/tags.scm plus range intersections. The layer would produce a line such as "changed: `AuthService.validateToken` (body), `parseConfig` (signature)". The other option is `sem`, after checking it against our stack. The diff format for the model should follow PR-Agent.
4. **Do not overrate structure in (A).** The PR description, the issue and the reading order give the agent several times more. The structural layer is useful for removing noise, and the model already infers structure from text.
5. Run our own experiment, because the literature has none. It would use the same PRs, model and prompt, and compare a unified diff with collapsed formatting plus marked moves. The metric is recall on PRs with known defects.

## Addendum: Reddit corpus (received separately)

The discussion volume is smaller than the reputation suggests, with ~15 substantive threads. The consensus is that difftastic is a **read-only tool used selectively**, alongside delta rather than as its replacement.

Three complaints recur with supporting reports. Memory on large files reaches gigabytes, and users switch back to delta. difftastic cannot produce a patch, which breaks magit and `git add -p`, so users converge on an alias for `git diff --no-ext-diff`. Side-by-side output is unreadable in narrow windows at ~35 characters per column, and the width is not recalculated on resize.

The only correctness complaint with a reproduction is that **reordering 2 methods in a class appears as a full delete+insert**. That is exactly the gap that competitors from 2024–2026 start with (SemanticDiff, diffmantic.nvim, sem). The corpus also confirms that difftastic's author admits diffsitter is faster. Dijkstra is the bottleneck, with 65% of time spent in hashmaps and O(N²) memory.

An adjacent discussion adds a relevant observation. In the r/golang thread "how do you review large AI diffs", nobody mentions difftastic. The top replies are "split PRs" (168 votes) and "read tests first". One person asks for exactly our tool ("separate renames/moves from behavioral changes"). sem also has a useful positioning line: "difftastic makes the diff readable, sem makes it queryable".

## Unverified

There are no hands-on measurements, because installing difftastic requires permission. Reddit was unavailable during the research. The "Semantic" mode's mechanism is undisclosed. The diffsitter JSON schema was inferred from code and not checked by running it. SemanticDiff on-prem is available only through "contact us".
