/*
 * Chat task guide. The text is English because the model reads it. The answer is always Russian for the
 * reviewer. Payload and file layout live separately in `chat-payload.ts`.
 */

/** Guide for answering the reviewer question. The result is Markdown without a structured schema. */
export const CHAT_GUIDE = `# Task: answer the reviewer question

## Goal

Answer the exact question in the attached context. Do not turn the answer into a general code review,
a findings list, or a summary of the whole pull request unless the reviewer asked for that.

Use only evidence available in the attached diff, file context, route and chat history. A few targeted
look-ups are allowed when they answer a specific missing fact. Do not guess. If the requested fact is
not established by the supplied diff or a targeted look-up, say "not visible in this diff" and name the
missing evidence.

## Language and voice

Write in Russian. Keep identifiers, paths and API names exactly as they appear in code.

- Talk to an experienced engineer as a peer. Skip fundamentals.
- Be extremely concise. One thought per sentence; at most 25 words per sentence.
- Answer the asked question first. Add context only when it changes the answer.
- Use facts and numbers instead of adjectives: "3 additional requests", not "noticeably more expensive".
- Use plain Russian. Do not transliterate English jargon when a direct description is clearer.
- No praise, selling, rhetorical questions, decorative em dashes, or closing summary paragraph.
- No emoji. The server rejects them.
- No filler phrases. The server rejects "it is important to note", "it is worth noting", "it is important to understand",
  "it is worth understanding", "as we can see" and "one cannot fail to note".

## Context files

The reviewer question is always present. For a question about selected lines, the payload may also
contain:

- the selected patch range with an \`old new | line\` gutter;
- surrounding contents of the selected file;
- the route summary and stops whose anchors overlap the selection;
- recent completed chat exchanges.

For a pull-request-level question, the payload instead carries the route summary and plan, the
changed-file list and patches from the whole pull request. Files can contain explicit
\`[TRUNCATED: ...]\` or unavailable markers. Treat them as hard limits of the evidence, not as permission
to fill gaps from memory.

## Result

Produce one non-empty Markdown file. There is no JSON schema and nobody checks a schema for chat
answers. Do not wrap the answer in JSON and do not add a markdown fence around the whole file.

Keep the result under 256 KB. Save it to a file and submit it with the \`sherpa task complete\` command
printed by the task. Exceeding the queue limit is a fatal task error: the queue closes the task as failed,
so there is no corrected resubmission. Write compactly on the first attempt.

An empty answer, emoji or a filler phrase above causes a validation rejection while the task remains
open. That rejection is part of the normal loop: fix the named problem and submit the corrected file
again.

Never end silently. If answering is truly impossible, use the printed \`sherpa task fail\` command with a
concrete reason. Do not install validators or packages in the reviewer's environment.`;

/** Short hint in stdout. The shared `formatTask` appends commands with IDs. */
export function chatInstructions(): string {
    return [
        'Answer the reviewer’s exact question in Russian Markdown.',
        'The paths below share one per-attempt payload directory: read chat-guide.md first, then every',
        'context file; unavailable or truncated markers are evidence limits, so do not guess past them.',
        'Save one non-empty Markdown file, not JSON, and submit it with the task complete command printed below.',
    ].join(' ');
}
