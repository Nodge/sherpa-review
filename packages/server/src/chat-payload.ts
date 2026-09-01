import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { ChatAnchor, PrMeta } from '@sherpa/protocol';

import type { EnqueueInput } from './queue.js';

export interface ChatPayload {
    readonly instructions: string;
    readonly questionFile: string;
}

/** Minimal T3 integration: T4 replaces the context contents without changing orchestration. */
export function buildChatPayload(question: string, anchor: ChatAnchor | null, pr: PrMeta | null): ChatPayload {
    const scope = anchor === null ? 'the whole PR' : `${anchor.path}:${String(anchor.start)}–${String(anchor.end)} (${anchor.side})`;
    const prText = pr === null ? 'PR metadata is unavailable.' : `PR: ${pr.title}\nURL: ${pr.url}`;
    return {
        instructions: [
            'Answer the reviewer question in Russian Markdown.',
            'Read it from the context file and use only evidence available there.',
            'Return a concrete, non-empty answer without emoji or filler phrases.',
            'Submit it with the `sherpa task complete` command shown below.',
        ].join(' '),
        questionFile: [`# Reviewer question`, '', question, '', `Scope: ${scope}`, prText, ''].join('\n'),
    };
}

/** Materializes a separate question directory: retry does not overwrite the previous task payload. */
export async function materializeChatPayload(payloadDir: string, payload: ChatPayload): Promise<EnqueueInput> {
    const taskDir = path.join(payloadDir, randomUUID());
    await fs.mkdir(taskDir, { recursive: true });
    const questionFile = path.join(taskDir, 'question.md');
    await fs.writeFile(questionFile, payload.questionFile, { encoding: 'utf8', mode: 0o600 });
    return {
        type: 'chat',
        priority: 'interactive',
        instructions: payload.instructions,
        contextFiles: [questionFile],
    };
}
