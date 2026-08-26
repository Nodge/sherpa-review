import type { RouteStop } from '@sherpa/protocol';

import type { EnqueueInput } from './queue.js';

/**
 * Payload for route generation tasks, an M2-T4 stub.
 *
 * The actual contents (context written as Markdown files in the PR temporary directory,
 * a result JSON schema file, prompts following the design rules) arrive in M2-T5. This is
 * only the task structure, so the queue → worker → validator → snapshot loop works end to end.
 * The text is in English because the model reads it.
 *
 * Priority is background. Route generation takes minutes and must not run ahead of work the reviewer
 * is waiting for on screen (rpc-design §5).
 */

/** The `route.skeleton` task: summary, stop plan and full tour order in one result. */
export function skeletonTaskInput(): EnqueueInput {
    return {
        type: 'route.skeleton',
        priority: 'background',
        instructions: [
            'Plan the review route for this pull request.',
            '',
            'Return JSON with `summary`, `stops` (title, tier, intent — in triage order, most important',
            'first) and `tourOrder` (a permutation of the plan numbers 1..N).',
            '',
            'The context and the result schema are materialised by the server in M2-T5; until then,',
            'read the diff with your own tools.',
        ].join('\n'),
        contextFiles: [],
    };
}

/**
 * The `route.section` task fills one or more planned stops. Target numbers go
 * in the task text. `taskSchema` has no separate field, so the server controls batching.
 * Other has no sections: the skeleton synthesized it, and the UI computes its contents.
 */
export function sectionTaskInput(
    planIndexes: readonly number[],
    stops: readonly RouteStop[],
    intents: ReadonlyMap<number, string>,
): EnqueueInput {
    const targets = stops.filter((stop) => planIndexes.includes(stop.planIndex) && stop.tier !== 'other');
    return {
        type: 'route.section',
        priority: 'background',
        instructions: [
            `Fill in these stops of the review route: ${planIndexes.join(', ')}.`,
            '',
            ...targets.map((stop) =>
                [
                    `Stop ${String(stop.planIndex)} (${stop.tier}): ${stop.title}`,
                    `  intent: ${intents.get(stop.planIndex) ?? '—'}`,
                ].join('\n'),
            ),
            '',
            'Return JSON with `stops`: for every stop above — `planIndex`, `paragraph`, optional `bridge`,',
            '`anchors` (path, side, start, end) and optional `tests` (the behavioural digest).',
            '',
            'The context and the result schema are materialised by the server in M2-T5; until then,',
            'read the diff with your own tools.',
        ].join('\n'),
        contextFiles: [],
    };
}
