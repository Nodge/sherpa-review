import type { z } from 'zod';

import type { RouteValidation } from './types.js';

/**
 * First acceptance step: raw result file text (`sherpa task complete --file`) → JSON → schema.
 * Fails closed: anything that cannot be parsed returns a list of English errors for the model.
 */

/** Allowed language for a markdown fence around the result: models habitually wrap JSON. */
const FENCE_TAG = /^[a-zA-Z0-9_-]*$/;

/**
 * Unwrap ```json … ```. Only a proper fence is stripped: triple backticks at the start,
 * a language tag without spaces and closing backticks later in the text.
 */
export function stripCodeFence(rawText: string): string {
    const text = rawText.trim();
    if (!text.startsWith('```')) {
        return text;
    }
    const firstBreak = text.indexOf('\n');
    if (firstBreak === -1 || !FENCE_TAG.test(text.slice(3, firstBreak).trim())) {
        return text;
    }
    const closing = text.lastIndexOf('```');
    if (closing <= firstBreak) {
        return text;
    }
    return text.slice(firstBreak + 1, closing);
}

/**
 * Parse a task result against the protocol schema. `label` names the root in error messages
 * so the model sees the full field path (`stops[0].anchors[1].start`).
 */
export function parseResult<T>(rawText: string, schema: z.ZodType<T>, label: string): RouteValidation<T> {
    const text = stripCodeFence(rawText);
    let json: unknown;
    try {
        json = JSON.parse(text);
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return {
            ok: false,
            errors: [
                `Result is not valid JSON: ${reason}. Return a single JSON object matching the ${label} schema; a \`\`\`json fence around it is allowed.`,
            ],
        };
    }

    const parsed = schema.safeParse(json);
    if (!parsed.success) {
        return { ok: false, errors: schemaErrors(parsed.error, label) };
    }
    return { ok: true, value: parsed.data };
}

/** Schema errors use the same format as semantic errors: `path: what is wrong`. */
function schemaErrors(error: z.ZodError, label: string): string[] {
    return error.issues.map((issue) => `${label}${formatPath(issue.path)}: ${issue.message}`);
}

function formatPath(path: readonly PropertyKey[]): string {
    return path
        .map((segment) => (typeof segment === 'number' ? `[${String(segment)}]` : `.${String(segment)}`))
        .join('');
}
