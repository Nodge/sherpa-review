import fs from 'node:fs/promises';
import path from 'node:path';

import type { Locale, Verdict } from '@sherpa/protocol';
import { generateJsonSchemas } from '@sherpa/protocol';

import type { FeedbackComment, FeedbackRoundContext, FeedbackThread } from './hosts/select.js';
import { fitPayloadFiles, fitText, unavailableBlock } from './payload-budget.js';
import type { EnqueueInput } from './queue.js';

/**
 * Local review round context for the agent: one markdown file with the verdict, paths,
 * anchors and thread conversations, plus a result schema file. The text is in English because
 * the model reads it.
 */

/** Size limit for `feedback.md`: a round with a hundred threads must not crowd out the session context. */
export const FEEDBACK_PAYLOAD_BUDGET_BYTES = 256 * 1024;

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export interface FeedbackPayload {
    readonly instructions: string;
    readonly context: string;
    readonly schema: string;
}

/** Complete round payload: prompt, context and result schema. */
export function buildFeedbackPayload(
    context: FeedbackRoundContext,
    locale: Locale,
    budgetBytes = FEEDBACK_PAYLOAD_BUDGET_BYTES,
): FeedbackPayload {
    const [file] = fitPayloadFiles(
        [
            {
                name: 'feedback.md',
                order: 0,
                minimum: unavailableBlock(
                    'Review round',
                    'The review round did not fit in the payload budget.',
                ),
                render: (maxBytes) =>
                    fitText(
                        roundContextMarkdown(context),
                        maxBytes,
                        unavailableBlock(
                            'Review round',
                            'The review round did not fit in the payload budget.',
                        ),
                    ),
            },
        ],
        budgetBytes,
    );

    return {
        instructions: feedbackInstructions(context, locale),
        context: file?.content ?? '',
        schema: `${JSON.stringify(generateJsonSchemas().reviewFeedbackResult, null, 2)}\n`,
    };
}

/**
 * Task prompt: exactly what the agent must do with this round. It also names the reply language,
 * which acceptance uses to validate voice, so the request and validation must agree.
 */
export function feedbackInstructions(context: FeedbackRoundContext, locale: Locale): string {
    const writeIn = `Write the replies and the summary in ${locale === 'ru' ? 'Russian' : 'English'}.`;
    const tail =
        'The working tree is re-read automatically; do not run any other Sherpa command for this.';
    const guidance = verdictGuidance(context.verdict);
    const opening = guidance.opening(context.projectDir);
    if (context.threads.length === 0) {
        return [
            opening,
            `${guidance.empty} Nothing to fix: submit a result with an empty replies list and a one-line summary.`,
            writeIn,
            tail,
        ].join(' ');
    }

    return [
        opening,
        'The review comments are in feedback.md, each with the absolute file path, line and code excerpt.',
        'Reply to every thread by threadId in the result file (see schema): what you did, or why you did not.',
        writeIn,
        'Never edit files outside the project directory.',
        guidance.comments,
        tail,
    ].join(' ');
}

interface VerdictGuidance {
    /** Opening prompt sentence describing what the reviewer did. */
    readonly opening: (projectDir: string) => string;
    /** A round without threads. */
    readonly empty: string;
    /** What to do with comments. */
    readonly comments: string;
}

const FIX_EVERY_COMMENT =
    'Fix the code for every comment. If a comment is unclear or you disagree, reply in the thread and leave the code as is.';

/**
 * What the agent should do with a round based on its publication mode. Local review now publishes only `comment`.
 * ship and request_changes remain for previously published rounds that have not yet finished.
 */
function verdictGuidance(verdict: Verdict): VerdictGuidance {
    switch (verdict) {
        case 'comment':
            return {
                opening: (projectDir) => `The reviewer published review comments on the local checkout ${projectDir}.`,
                empty: 'The reviewer published no comments in this round.',
                comments: FIX_EVERY_COMMENT,
            };
        case 'request_changes':
            return {
                opening: (projectDir) =>
                    `The reviewer finished a review round on the local checkout ${projectDir}, verdict request_changes.`,
                empty: 'The reviewer left no comments in this round.',
                comments: FIX_EVERY_COMMENT,
            };
        case 'ship':
        case 'sticky_ship':
            return {
                opening: (projectDir) =>
                    `The reviewer finished a review round on the local checkout ${projectDir}, verdict ${verdict}.`,
                empty: 'The reviewer approved the changes without comments.',
                comments: 'The changes are approved. The comments are optional: apply the trivial ones, reply to the rest.',
            };
        default:
            return unreachableVerdict(verdict);
    }
}

function unreachableVerdict(verdict: never): never {
    throw new Error(`unknown round verdict ${String(verdict)}`);
}

/** Creates the round directory and assembles the queue task. */
export async function materializeFeedbackPayload(
    taskDir: string,
    payload: FeedbackPayload,
): Promise<EnqueueInput> {
    await fs.mkdir(taskDir, { recursive: true, mode: DIR_MODE });
    await fs.chmod(path.dirname(taskDir), DIR_MODE);
    await fs.chmod(taskDir, DIR_MODE);

    const contextFile = path.join(taskDir, 'feedback.md');
    const schemaFile = path.join(taskDir, 'result-schema.json');
    await fs.writeFile(contextFile, payload.context, { encoding: 'utf8', mode: FILE_MODE });
    await fs.writeFile(schemaFile, payload.schema, { encoding: 'utf8', mode: FILE_MODE });

    return {
        type: 'review.feedback',
        // The reviewer is waiting on screen for fixes, so the round takes priority over background route generation.
        priority: 'interactive',
        instructions: payload.instructions,
        contextFiles: [contextFile],
        resultSchemaFile: schemaFile,
    };
}

/** Round context: verdict, project directory and threads in order. */
export function roundContextMarkdown(context: FeedbackRoundContext): string {
    const head = [
        '# Review round',
        '',
        `Verdict: ${context.verdict}`,
        `Project directory: ${context.projectDir}`,
        `Threads in this round: ${String(context.threads.length)}`,
        '',
        'Reply to a thread by its threadId. Line numbers are the ones of the diff excerpt:',
        'the gutter is `old new | line`, `.` means the line does not exist on that side.',
        '',
    ];
    if (context.threads.length === 0) {
        return [...head, 'The reviewer published no comments in this round.', ''].join('\n');
    }
    return [...head, ...context.threads.map(threadBlock), ''].join('\n');
}

function threadBlock(thread: FeedbackThread): string {
    return [
        `## Thread ${thread.threadId} — ${threadPlace(thread)}`,
        '',
        `Resolved: ${thread.resolved ? 'yes' : 'no'}`,
        ...(thread.note === null ? [] : [`Excerpt: [UNAVAILABLE: ${thread.note}]`]),
        ...(thread.excerpt === null ? [] : ['', '```', thread.excerpt, '```']),
        '',
        'Comments (oldest first):',
        '',
        ...thread.comments.flatMap((comment) => commentLines(comment, 0)),
        '',
    ].join('\n');
}

/** Thread location: a line in a file, the whole file or the PR. */
function threadPlace(thread: FeedbackThread): string {
    if (thread.file === null) {
        return 'pull request level, no file';
    }
    if (thread.position === null) {
        return `${thread.file} (whole file)`;
    }
    const { side, line, size } = thread.position;
    const range = size > 1 ? `${String(line)}-${String(line + size - 1)}` : String(line);
    return `${thread.file}, ${side} side, line ${range}`;
}

function commentLines(comment: FeedbackComment, depth: number): string[] {
    const indent = '  '.repeat(depth);
    const author = comment.author.bot ? `${comment.author.login} (agent)` : comment.author.login;
    return [
        `${indent}- ${author}, ${comment.createdAt}:`,
        ...comment.body.split('\n').map((line) => `${indent}  ${line}`),
        ...comment.replies.flatMap((reply) => commentLines(reply, depth + 1)),
    ];
}
