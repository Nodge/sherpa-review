export type PaletteQuery =
    | { readonly kind: 'browse'; readonly text: string }
    | { readonly kind: 'diff'; readonly text: string }
    | { readonly kind: 'line'; readonly line: number | null };

/** Parses palette prefixes. `@` remains an ordinary query until M5. */
export function parsePaletteQuery(query: string): PaletteQuery {
    const trimmed = query.trim();
    if (trimmed.startsWith('/')) {
        return { kind: 'diff', text: trimmed.slice(1).trim() };
    }
    if (trimmed.startsWith(':')) {
        const value = trimmed.slice(1).trim();
        return { kind: 'line', line: /^\d+$/.test(value) && Number(value) > 0 ? Number(value) : null };
    }
    return { kind: 'browse', text: trimmed };
}
