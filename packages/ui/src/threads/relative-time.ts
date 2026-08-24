/** Short relative time for thread metadata. Injected `now` keeps the gallery deterministic. */
export function relativeTime(createdAt: string, now: number): string {
    const created = Date.parse(createdAt);
    if (!Number.isFinite(created)) {
        return 'just now';
    }
    const seconds = Math.max(Math.floor((now - created) / 1000), 0);
    if (seconds < 60) {
        return 'just now';
    }
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
        return `${String(minutes)} min ago`;
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
        return `${String(hours)} h ago`;
    }
    const days = Math.floor(hours / 24);
    if (days < 7) {
        return `${String(days)} d ago`;
    }
    const weeks = Math.floor(days / 7);
    if (days < 30) {
        return `${String(weeks)} wk ago`;
    }
    const months = Math.floor(days / 30);
    if (days < 365) {
        return `${String(months)} mo ago`;
    }
    return `${String(Math.floor(days / 365))} y ago`;
}
