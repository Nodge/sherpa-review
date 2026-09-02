/** Number formatting and Russian plural forms: one set of rules for the whole UI. */

/** Non-breaking spaces group digits: "2 412 changed lines", the Russian notation of SPEC §2.13. */
export function formatCount(value: number): string {
    return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0');
}

/** The label shows 7 hex characters of the commit (README §13). `title` holds the full hash. */
export function shortCommit(commit: string): string {
    return commit.slice(0, 7);
}

export function plural(value: number, one: string, few: string, many: string): string {
    const mod100 = Math.abs(value) % 100;
    if (mod100 >= 11 && mod100 <= 14) {
        return many;
    }
    const mod10 = mod100 % 10;
    if (mod10 === 1) {
        return one;
    }
    return mod10 >= 2 && mod10 <= 4 ? few : many;
}
