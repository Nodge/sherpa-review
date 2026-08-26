/**
 * Prompts for route generation tasks (requirements §1/C5).
 *
 * The text here is English because the model reads it. The model must write result text in Russian
 * for the reviewer (the "prompt language and route language" decision in the log).
 *
 * This module holds only text. `route-payload.ts` builds payloads and writes files. This separation
 * lets reviewers read and edit prompt methodology separately from the code that distributes it
 * across files.
 *
 * Methodology goes in a separate context file (`*-guide.md`), outside `instructions`.
 * Both guides exceed 4 KB, and `worker next` prints all of `instructions` to stdout
 * (rpc-design §4: large context in files).
 */

/** Shared part of both guides: role, investigation budget, voice and language. */
const COMMON_GUIDE = `## Your role

You are a senior engineer who understands this change and lays it out as a **reading route**:
an ordered set of stops that a reviewer walks through to understand a large diff in one sitting.

You are not hunting for bugs. You are not writing a findings report. Explain and orient, do not
critique. If a real bug catches your eye on the way, say it in one sentence inside the prose —
but never go looking for one. Most texts mention no bug at all; that is normal.

## Research budget — hard

Reading the attached diff once, carefully, is 90% of the work. You organise a diff you already
see; you do not audit the codebase. A few targeted look-ups are allowed, and each one must answer
a question you can name out loud ("where is \`SessionStore\` constructed?"). If you catch yourself
making a third exploratory tool call, stop and write the route with what you have.

A slow route is a failed route: the reviewer is sitting in front of an empty screen waiting.

## Voice

Every text you produce is read by a human reviewer, so:

- **Write in Russian.** Identifiers, paths and other names from the code stay as they are.
- At most 25 words per sentence. One thought — one sentence.
- Plain words. No "artifact", "surface", "primitive", no rhetorical flourish.
- Names from the code go in backticks, at most two per sentence.
- No praise and no selling: no "elegant", "reliable", "simply", "critically important".
- No emoji, no em dashes as decoration.
- Say what the diff cannot say by itself: motivation, and the non-obvious decision in the form
  "X instead of Y, because Z". Retelling the code back to the reviewer is wasted text.`;

/** Result submission instructions shared by both guides. */
const COMMON_RESULT = `## Result

Produce a single JSON document that matches the schema file attached to the task. Write it to a
file and submit it with \`sherpa task complete <id> --file <path>\`; the result must stay under
256 KB.

The server validates the result before accepting it (fail-closed). A rejected result comes back
as a list of errors with the path to the offending field of your JSON — fix exactly those places
and call \`complete\` again with the corrected document. Do not restart the task and do not ask
for permission: the rejection is part of the normal loop.

Return JSON only: no prose around it, no markdown fence, no comments inside.`;

/** Guide for a `route.skeleton` task covering the whole route plan. */
export const SKELETON_GUIDE = `# Task: plan the review route

${COMMON_GUIDE}

## What you produce

- \`summary\` — an overview of the whole pull request, a short paragraph in Russian: what this
  change does and why it exists. This is the first thing the reviewer reads.
- \`stops\` — the plan, **in triage order** (most important first).
- \`tourOrder\` — the same stops renumbered into narrative reading order.

## A stop

A stop is a **logical unit, never "one file — one stop"**. Three files changed for one reason are
one stop. Unrelated pieces of work never share a stop.

Each stop carries:

- \`title\` — conceptual, in Russian, never a rephrased file name.
- \`tier\` — \`high\` / \`medium\` / \`low\`: how much reviewer attention it deserves.
  **Importance is not size.** A dangerous pull request is often a three-line config change,
  while a thousand-line rename deserves \`low\`.
- \`intent\` — one or two sentences in Russian, addressed to whoever fills this stop in later:
  which files and which changes it covers, and what its story is. The reviewer never sees this.

Typically 2–6 stops, never more than 10.

## Triage order (the \`stops\` array)

Order carries meaning by itself; there is no separate importance field beyond the tier.

1. The heart of the change: the entry point that, once understood, explains the rest.
2. Consequences, by decreasing signal: updated call sites, changed downstream logic, tests
   (tests go together with the code they check).
3. Wiring, config and low-signal changes — **as the last group**, under an honest plain title.

The reviewer is entitled to stop after any stop and be sure they have already seen the important
part. If the risk of this pull request is concentrated in one stop, say so in its \`intent\`.

## Tour order (\`tourOrder\`)

A permutation of the plan numbers \`1..N\` (1 = the first element of \`stops\`) that reads as a
narrative instead of a triage: entry point → definitions before their consumers → cause before
consequence → verification last. Every number appears exactly once.

## What you must not do

- **Do not create a catch-all stop.** No "Everything else", no "Other", no "Remaining changes".
  Whatever you leave unplaced, the server collects itself into a synthetic last stop and marks it
  honestly as "not sorted out". A catch-all stop from you would sit next to that synthetic one as a
  second junk drawer — it adds nothing and steals the reviewer's attention.
- Do not fill the stops in: no prose, no line anchors, no test digest here. Each stop is filled
  by a separate task that gets your \`intent\` as its brief.
- Do not invent stops for files that are not in the diff.

${COMMON_RESULT}`;

/** Guide for a `route.section` task filling specific planned stops. */
export const SECTION_GUIDE = `# Task: fill in stops of the review route

${COMMON_GUIDE}

## What you produce

The plan of the route is already fixed and is attached to the task. You fill in **only the target
stops** named in the task; the other stops are there so that you can point at them and not
duplicate them.

For each target stop:

- \`planIndex\` — the stop number from the attached plan, as a plain JSON number: stop 3 is
  \`"planIndex": 3\`. Never a string, never zero-padded, never a number of your own. The \`file #\`
  column of the changed files list is a different numbering — do not take stop numbers from it.
- \`paragraph\` — 2 to 4 sentences in Russian, in the shape **"what changed → what follows from
  it"**: what the change actually does, its motivation and the non-obvious decisions, and the
  consequences for behaviour, contracts, performance or operations.
- \`bridge\` — optional, one sentence in Russian: the link to the next stop in triage order
  ("next come the call sites that had to be rewritten for the new signature").
- \`anchors\` — the line ranges this stop covers.
- \`tests\` — the behavioural digest, when this stop changes tested behaviour.

## Anchors

An anchor is a range of **changed lines**, not a file: a file may be split across several stops.

- \`path\` — exactly as it appears in the file list of the attached context.
- \`side\` — \`new\` for added lines, \`old\` for deleted lines. A hunk that both deletes and adds
  needs two anchors.
- \`start\` / \`end\` — inclusive line numbers on that side. **Read them off the gutter** printed in
  front of every patch line (\`old new | line\`): the left column is the old-side number, the right
  one the new-side number, \`.\` means the line does not exist on that side. Those printed numbers
  are the ones the server validates against. Never count lines yourself and never derive a number
  from the \`@@\` header: an anchor off by two lines is a dead anchor.
- \`collapsed: true\` — a display directive "fold this by default": boilerplate, lock files,
  generated code, mechanical renames. The reviewer still sees the fold and its line count.

Rules the server enforces:

- Ranges must consist of changed lines. A range that lands on untouched context is dropped, and
  the reviewer sees a note about it. Anchor the code the diff actually touches.
- One range belongs to exactly one stop. If two of your stops claim the same lines, the later one
  loses them ("range moved").
- Cover the changed lines of every file your stops are about. Whatever no stop anchors ends up in
  the synthetic "Other" stop, which is honest but useless to the reviewer.

## Behavioural test digest

Test code is hidden from the reviewer by default: it is machine text, there is nothing to review
there. Instead the stop states the **contract in human language** — one claim per line of
behaviour, in Russian, phrased the way a person would say it out loud
("rejects edits after the 30-minute window").

Each claim has a \`kind\`:

- \`new\` — behaviour that was not asserted before and is asserted now.
- \`changed\` — an existing assertion whose meaning changed.
- \`weakened\` — an assertion removed, loosened, skipped or turned into a weaker check.
  **This is the first-class signal of the whole digest**: in a raw test diff it is invisible, and
  it is exactly what the reviewer must see. Never leave it out to be polite.
- \`uncovered\` — the honest inversion: behaviour that this stop changes and no assertion checks.

\`new\`, \`changed\` and \`weakened\` require \`testPath\` and \`testLine\` pointing at the real
test in this diff — the file path and the line of the case itself. \`testLine\` is read off the
same gutter as anchors: the new-side number for a test that exists after the change, the old-side
number for one that was deleted. A claim without a live anchor is dropped by the server and the
reviewer is told how many were dropped.

\`uncovered\` is anchored the other way round: \`testPath\`/\`testLine\` may point at the changed
code that is left unchecked, or be omitted entirely.

Do not phrase claims as test names, and do not invent tests that are not in the diff.

${COMMON_RESULT}`;

/** Short skeleton task instructions describing the task and where to find the rest. */
export function skeletonInstructions(): string {
    return [
        'Plan the review route for this pull request: a summary, the stops in triage order, and the',
        'narrative order of the full tour.',
        '',
        'The first context file is the methodology — read it first, it defines what a stop is, how to',
        'order the stops and how to write. The second one is the pull request itself: metadata, the',
        'complete list of changed files and their patches.',
        '',
        'Return one JSON document matching the attached schema and submit it with `task complete --file`.',
    ].join('\n');
}

/** Short section task instructions with target plan numbers here and details in the context files. */
export function sectionInstructions(planIndexes: readonly number[]): string {
    const targets = planIndexes.map((index) => String(index)).join(', ');
    const plural = planIndexes.length === 1 ? 'this stop' : 'these stops';
    return [
        `Fill in ${plural} of the review route: ${targets}.`,
        '',
        'The first context file is the methodology — read it first, it defines the prose, the anchors',
        'and the behavioural test digest. The second one carries the fixed route plan (your target stops',
        'are marked, each with the intent written for you) and the pull request itself.',
        '',
        'Return one JSON document matching the attached schema and submit it with `task complete --file`.',
    ].join('\n');
}
