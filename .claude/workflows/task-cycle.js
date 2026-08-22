export const meta = {
  name: 'task-cycle',
  description: 'One Sherpa task cycle: Opus coder → checks → two reviews (Opus + Codex) → triage → fixes',
  whenToUse: 'Run for one task from plan/M*-tasks.md. args: { taskId, brief, gateCmd?, maxFixRounds? }. Changes stay in the working tree. Commit and visual acceptance happen outside this workflow.',
  phases: [
    { title: 'Implement', detail: 'Opus coder implements the brief', model: 'opus' },
    { title: 'Gates', detail: 'typecheck / lint / tests' },
    { title: 'Review', detail: 'two independent reviews: Opus and Codex', model: 'opus' },
    { title: 'Triage', detail: 'arbitration and finding deduplication' },
    { title: 'Fix', detail: 'fix confirmed findings and verify with evidence', model: 'opus' },
  ],
}

const REPO = '/Users/alice/Sites/sherpa'
const taskId = args && args.taskId
const brief = args && args.brief
const gateCmd = (args && args.gateCmd) || 'pnpm -r typecheck && pnpm -r lint && pnpm -r test'
const maxFixRounds = (args && args.maxFixRounds) != null ? args.maxFixRounds : 2

if (!taskId || !brief) throw new Error('args.taskId and args.brief are required')

// ---------- Result schemas ----------

const IMPL_SCHEMA = {
  type: 'object',
  required: ['summary', 'changedFiles', 'gatesPassed'],
  properties: {
    summary: { type: 'string', description: 'What was done and which decisions were made along the way' },
    changedFiles: { type: 'array', items: { type: 'string' } },
    gatesPassed: { type: 'boolean' },
    gatesNote: { type: 'string', description: 'Check output, or why the checks do not apply' },
    deviations: { type: 'string', description: 'Deviations from the brief, if any' },
  },
}

const GATES_SCHEMA = {
  type: 'object',
  required: ['passed'],
  properties: {
    passed: { type: 'boolean' },
    failures: { type: 'string', description: 'Relevant output from failed commands' },
    notApplicable: { type: 'boolean', description: 'true if the check infrastructure does not exist yet' },
  },
}

const FINDINGS_SCHEMA = {
  type: 'object',
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['file', 'title', 'severity', 'description'],
        properties: {
          file: { type: 'string' },
          line: { type: 'integer' },
          severity: { enum: ['blocker', 'major', 'minor'] },
          title: { type: 'string' },
          description: { type: 'string', description: 'What is wrong, what it risks, how to verify it' },
        },
      },
    },
  },
}

const TRIAGE_SCHEMA = {
  type: 'object',
  required: ['confirmed', 'rejected'],
  properties: {
    confirmed: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'reason'],
        properties: {
          id: { type: 'string' },
          reason: { type: 'string', description: 'Why the finding is confirmed, with a code reference' },
        },
      },
    },
    rejected: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'reason'],
        properties: { id: { type: 'string' }, reason: { type: 'string' } },
      },
    },
  },
}

const VERIFY_SCHEMA = {
  type: 'object',
  required: ['resolved', 'unresolvedIds', 'gatesPassed'],
  properties: {
    resolved: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'evidence'],
        properties: {
          id: { type: 'string' },
          evidence: {
            type: 'string',
            description: 'Evidence of the fix: file:line after the fix and what is there now, so the process owner can recheck without rereading the whole diff',
          },
        },
      },
    },
    unresolvedIds: { type: 'array', items: { type: 'string' } },
    gatesPassed: { type: 'boolean' },
    notes: { type: 'string' },
  },
}

// ---------- Shared prompt fragments ----------

const commonContext = `Repository: ${REPO}. Read CLAUDE.md and follow its procedure.
Task ${taskId}. Task brief:

---
${brief}
---
`

const diffInstruction = `The task changes are NOT committed: inspect \`git status\` and \`git diff\` in ${REPO}, plus the full contents of new (untracked) files.`

// ---------- 1. Implementation ----------

phase('Implement')
log(`Task ${taskId}: Opus coder started`)

const impl = await agent(
  `You are the coder. ${commonContext}
Implement the task strictly according to the brief. Stay within its scope. Record disputed decisions in deviations instead of silently inventing them.
Before finishing, run the checks: \`${gateCmd}\`, and get them passing. If the checks do not apply (the required infrastructure does not exist yet and building it is outside the task), say so explicitly in gatesNote.
Do not commit anything. Leave changes in the working tree.`,
  { label: `implement:${taskId}`, phase: 'Implement', model: 'opus', schema: IMPL_SCHEMA },
)

if (!impl) throw new Error('Coder returned no result')
log(`Implementation ready: ${impl.changedFiles.length} files`)

// ---------- 2. Independent check run ----------

phase('Gates')

const gates = await agent(
  `Run the checks in ${REPO}: \`${gateCmd}\`. Report honestly: passed only if everything passes.
If the commands do not apply (no package.json / scripts because the project is at an early stage), set notApplicable: true and passed: true.
Do not fix or edit anything. Only run and report.`,
  { label: `gates:${taskId}`, phase: 'Gates', model: 'sonnet', effort: 'low', schema: GATES_SCHEMA },
)

if (gates && !gates.passed) {
  // One chance to fix checks before review, reviewing failing code makes no sense
  log('Checks failed, sending for repair before review')
  await agent(
    `You are the coder. ${commonContext}
${diffInstruction}
Checks \`${gateCmd}\` are failing. Output:
${gates.failures || '(output was not saved, run the checks yourself)'}
Fix the failures without changing the intent of the changes. Get the checks passing. Do not commit anything.`,
    { label: `fix-gates:${taskId}`, phase: 'Gates', model: 'opus', schema: IMPL_SCHEMA },
  )
  const regates = await agent(
    `Run the checks in ${REPO}: \`${gateCmd}\`. Report honestly. Do not edit anything.`,
    { label: `regates:${taskId}`, phase: 'Gates', model: 'sonnet', effort: 'low', schema: GATES_SCHEMA },
  )
  if (regates && !regates.passed) {
    return {
      taskId,
      status: 'failed',
      reason: 'Could not get the checks passing before review',
      gates: regates,
      implementation: impl,
    }
  }
}

// ---------- 3. Two reviews: Opus + Codex ----------
// The barrier is deliberate: triage needs both lists at once to deduplicate between reviewers.

phase('Review')
log('Two reviews: Opus and Codex in parallel')

const reviewPrompt = (who) => `You are an independent code reviewer (${who}). ${commonContext}
${diffInstruction}
Check the changes along four axes:
1. Compliance with the brief and source documents (sherpa-tz.md, sherpa-brief.md, rpc-design.md, design/design_handoff_sherpa/). Check the sections the brief references.
2. Correctness: bugs, edge cases, races, data loss.
3. Contracts: no host-specific concepts above ReviewHost, the UI consumes no unvalidated data, types come from packages/protocol.
4. Quality: unnecessary complexity, duplication, departures from repo style.
Only findings in this diff, do not review unrelated old code. Use severity honestly: blocker means cannot commit, major means must fix, minor can be deferred. If there are no findings, return an empty list. Do not invent any.`

const [opusReview, codexReview] = await parallel([
  () => agent(reviewPrompt('Claude/Opus perspective'), {
    label: `review-opus:${taskId}`, phase: 'Review', model: 'opus', effort: 'high', schema: FINDINGS_SCHEMA,
  }),
  () => agent(reviewPrompt('Codex/GPT perspective'), {
    label: `review-codex:${taskId}`, phase: 'Review', agentType: 'codex', schema: FINDINGS_SCHEMA,
  }),
])

if (!opusReview && !codexReview) throw new Error('Both reviewers failed. Cycle aborted')

const allFindings = []
for (const [source, review] of [['opus', opusReview], ['codex', codexReview]]) {
  if (!review) { log(`Reviewer ${source} returned no result, continuing with one`); continue }
  for (const f of review.findings) {
    allFindings.push({ id: `f${allFindings.length + 1}`, source, ...f })
  }
}
log(`Findings before triage: ${allFindings.length}`)

// ---------- 4. Triage ----------

phase('Triage')

let confirmed = []
if (allFindings.length > 0) {
  const triage = await agent(
    `You are the code review arbiter. ${commonContext}
${diffInstruction}
Two independent reviewers returned findings (source identifies the author):
${JSON.stringify(allFindings, null, 2)}
For each finding: verify it against the actual code (do not take it on trust), merge duplicates (confirm one id, reject the other with reason "duplicate <id>"), reject subjective preferences and false positives. Reject minor findings that do not affect correctness with the label "deferred". The process owner will pick them up from the report.
Every id must appear in either confirmed or rejected.`,
    { label: `triage:${taskId}`, phase: 'Triage', effort: 'high', schema: TRIAGE_SCHEMA },
  )
  if (!triage) throw new Error('Triage failed')
  const byId = Object.fromEntries(allFindings.map((f) => [f.id, f]))
  confirmed = triage.confirmed.map((c) => ({ ...byId[c.id], reason: c.reason })).filter((f) => f.file)
  log(`Confirmed: ${confirmed.length}, rejected: ${triage.rejected.length}`)
}

// ---------- 5. Fix loop ----------

phase('Fix')

let remaining = confirmed
let round = 0
// The report lists what was declared fixed and its evidence for the process owner to spot-check
const resolvedLog = []
while (remaining.length > 0 && round < maxFixRounds) {
  round++
  log(`Fix round ${round}/${maxFixRounds}: ${remaining.length} findings`)

  await agent(
    `You are the coder. ${commonContext}
${diffInstruction}
Review confirmed these findings. Fix each one:
${JSON.stringify(remaining, null, 2)}
Fix the underlying problems without patching over them. If a finding cannot be fixed within the brief, leave it and explain in summary. After the fixes, run the checks: \`${gateCmd}\`. Do not commit anything.`,
    { label: `fix-r${round}:${taskId}`, phase: 'Fix', model: 'opus', schema: IMPL_SCHEMA },
  )

  const verify = await agent(
    `You are the fix verifier. ${commonContext}
${diffInstruction}
Check the code to verify that each finding is actually resolved (be skeptical, the fix may be a patch or may have broken adjacent behaviour):
${JSON.stringify(remaining, null, 2)}
Then run the checks: \`${gateCmd}\`. Do not edit anything.
Every id must appear in either resolved (with evidence: file:line after the fix and what is there now) or unresolvedIds. Do not declare a finding fixed unless you can point to a specific place in the code. When in doubt, mark it unresolved.`,
    { label: `verify-r${round}:${taskId}`, phase: 'Fix', model: 'opus', effort: 'high', schema: VERIFY_SCHEMA },
  )
  if (!verify) throw new Error('Verifier failed')

  // Fail closed: only findings explicitly declared fixed with evidence leave remaining.
  // A finding the verifier omits stays open instead of disappearing from the report
  const unresolvedIds = new Set(verify.unresolvedIds)
  const byId = Object.fromEntries(remaining.map((f) => [f.id, f]))
  const resolvedIds = new Set()
  for (const r of verify.resolved) {
    const f = byId[r.id]
    if (!f || unresolvedIds.has(r.id) || resolvedIds.has(r.id)) continue
    resolvedIds.add(r.id)
    resolvedLog.push({ id: f.id, file: f.file, title: f.title, severity: f.severity, evidence: r.evidence })
  }
  remaining = remaining.filter((f) => !resolvedIds.has(f.id))
  log(`Round ${round}: fixed ${resolvedIds.size}, remaining ${remaining.length}`)
  if (!verify.gatesPassed) {
    log('Checks still fail after fixes. Another round')
    if (remaining.length === 0) remaining = confirmed.slice(0, 0).concat([{ id: 'gates', file: '(gates)', title: 'Checks still fail after fixes', severity: 'blocker', description: verify.notes || `Command: ${gateCmd}` }])
  }
}

// ---------- Summary ----------

const blockers = remaining.filter((f) => f.severity === 'blocker')
return {
  taskId,
  status: blockers.length > 0 ? 'needs_attention' : 'ready_for_commit',
  implementation: { summary: impl.summary, changedFiles: impl.changedFiles, deviations: impl.deviations || null },
  review: {
    total: allFindings.length,
    confirmed: confirmed.length,
    fixed: resolvedLog,
    remaining,
  },
  fixRounds: round,
  next: blockers.length > 0
    ? 'Unresolved blockers remain. Review them manually before committing'
    : 'Changes in the working tree: spot-check fixed[].evidence → visual acceptance (for UI tasks) → commit → update plan/',
}
