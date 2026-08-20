/**
 * Deterministic content generators for large fixtures (`large`, the `medium` lockfile).
 * There is no need to store megabytes of text in the repository, but the output must stay stable across
 * runs: everything comes from the line index, with no state or randomness.
 */

const IDENTIFIERS = [
    'orderId',
    'deliverySlot',
    'editWindow',
    'cutoffAt',
    'policy',
    'clock',
    'auditTrail',
    'paymentToken',
    'shipment',
    'reservation',
    'basket',
    'timeline',
];

const TS_STATEMENTS = [
    'const {name} = await this.repository.load(request.orderId);',
    'if ({name} === null) {',
    '    throw new OrderNotFound(request.orderId);',
    '}',
    'const deadline = this.clock.now().getTime() + EDIT_WINDOW_MS;',
    'this.logger.debug(`{name} resolved`, { orderId: request.orderId });',
    'if (!policy.allows({name})) {',
    '    return { allowed: false, reason: "edit-window-closed" } as const;',
    '}',
    'metrics.increment("checkout.edit_window.{name}");',
    'return { allowed: true, deadline } as const;',
];

/** Name from the pool by index, the same on every run. */
function identifierAt(index: number): string {
    const name = IDENTIFIERS[index % IDENTIFIERS.length];
    return name ?? 'value';
}

function statementAt(index: number): string {
    const statement = TS_STATEMENTS[index % TS_STATEMENTS.length];
    return (statement ?? 'return null;').replace('{name}', identifierAt(index));
}

/** `count` lines of plausible TS with the given hunk prefix (' ', '+' or '-'). */
export function tsLines(prefix: string, count: number, offset = 0): string[] {
    const lines: string[] = [];
    for (let i = 0; i < count; i += 1) {
        lines.push(`${prefix}    ${statementAt(offset + i)}`);
    }
    return lines;
}

/** pnpm lockfile lines: there are always plenty, and nobody reads them. Only the shape matters. */
export function lockLines(prefix: string, count: number, offset = 0): string[] {
    const lines: string[] = [];
    for (let i = 0; i < count; i += 1) {
        const index = offset + i;
        if (index % 3 === 0) {
            lines.push(`${prefix}  /@checkout/${identifierAt(index)}@1.${String(index % 40)}.${String(index % 7)}:`);
        } else if (index % 3 === 1) {
            lines.push(`${prefix}    resolution: {integrity: sha512-${index.toString(16).padStart(8, '0')}}`);
        } else {
            lines.push(`${prefix}    dev: ${index % 2 === 0 ? 'true' : 'false'}`);
        }
    }
    return lines;
}
