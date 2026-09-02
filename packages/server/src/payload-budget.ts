/**
 * Fitting task context files into the budget (rpc-design §4). Shared logic for payload
 * payloads. The same rule applies to both: "at most N bytes" counts the entire finished
 * file, and a truncated part is marked so the model cannot mistake it for the full text.
 */

/** A payload file not yet built: render runs once its remaining byte budget is known. */
export interface PayloadFileSpec {
    readonly name: string;
    readonly order: number;
    /** The file's worst-case budget usage: a notice in place of its text. */
    readonly minimum: string;
    readonly render: (maxBytes: number) => string;
}

/**
 * Array order sets priority. `order` only sets the order of task paths. The remaining budget
 * always reserves a notice for files not yet built.
 */
export function fitPayloadFiles(
    specs: readonly PayloadFileSpec[],
    budgetBytes: number,
): { name: string; content: string; order: number }[] {
    const budget = Math.max(0, budgetBytes);
    const files: { name: string; content: string; order: number }[] = [];
    let used = 0;

    for (let index = 0; index < specs.length; index += 1) {
        const spec = specs[index];
        if (spec === undefined) {
            continue;
        }
        const reserve = specs.slice(index + 1).reduce((total, next) => total + byteLength(next.minimum), 0);
        const maxBytes = Math.max(0, budget - used - reserve);
        const content = fitText(spec.render(maxBytes), maxBytes, spec.minimum);
        used += byteLength(content);
        files.push({ name: spec.name, content, order: spec.order });
    }

    return files;
}

/** A notice replacing the content: the file stays in the task without pretending to be complete. */
export function unavailableBlock(heading: string, reason: string): string {
    return `# ${heading}\n\n[TRUNCATED: ${reason}]\n`;
}

/** Fits text into a byte limit: replaces the tail with a notice, or `fallback` if that cannot fit. */
export function fitText(text: string, maxBytes: number, fallback: string): string {
    const max = Math.max(0, maxBytes);
    if (byteLength(text) <= max) {
        return text;
    }
    if (byteLength(fallback) >= max) {
        return truncateUtf8(fallback, max);
    }
    const marker = '\n\n[TRUNCATED: remaining content omitted by the payload budget.]\n';
    if (byteLength(marker) >= max) {
        return truncateUtf8(fallback, max);
    }
    const prefix = truncateUtf8(text, max - byteLength(marker)).trimEnd();
    return `${prefix}${marker}`;
}

/** Truncates by bytes without splitting a surrogate pair. */
export function truncateUtf8(text: string, maxBytes: number): string {
    if (maxBytes <= 0) {
        return '';
    }
    let low = 0;
    let high = text.length;
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (byteLength(text.slice(0, middle)) <= maxBytes) {
            low = middle;
        } else {
            high = middle - 1;
        }
    }
    let end = low;
    if (end > 0 && /[\uD800-\uDBFF]/.test(text.charAt(end - 1))) {
        end -= 1;
    }
    return text.slice(0, end);
}

export function byteLength(text: string): number {
    return Buffer.byteLength(text, 'utf8');
}
