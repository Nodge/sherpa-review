export const meta = {
  name: 'task-cycle-codex',
  description: 'Sherpa task cycle with a Codex/GPT coder, run only when Alice Ingram explicitly requests it',
  whenToUse: 'The same cycle as task-cycle, with a nested GPT session writing the code. Use task-cycle (Opus coder) by default. Use this variant only when Alice Ingram explicitly asks for Codex. Same args: { taskId, brief, gateCmd?, maxFixRounds? }.',
  phases: [
    { title: 'Implement', detail: 'Codex coder implements the brief' },
    { title: 'Gates', detail: 'typecheck / lint / tests' },
    { title: 'Review', detail: 'two independent reviews: Opus and Codex', model: 'opus' },
    { title: 'Triage', detail: 'arbitration and finding deduplication' },
    { title: 'Fix', detail: 'Codex coder fixes, Opus verifies with evidence', model: 'opus' },
  ],
}

// This wrapper has no logic of its own: task-cycle.js holds the only cycle implementation,
// and this file only selects the coder.
return await workflow('task-cycle', { ...(args || {}), coder: 'codex' })
