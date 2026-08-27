import type { PrMeta } from '@sherpa/protocol';

/** Top-bar breadcrumb segment. `href: null` means plain text. */
export interface BreadcrumbSegment {
    readonly text: string;
    readonly href: string | null;
}

/**
 * The PR key is `<host>-<pr>` (see the protocol's `prKeySchema`). The parsed key is the breadcrumb fallback:
 * the top bar uses it until PR metadata arrives in the snapshot.
 */
export function breadcrumbFromPrKey(prKey: string): readonly string[] {
    const separator = prKey.indexOf('-');
    if (separator <= 0 || separator === prKey.length - 1) {
        return [prKey];
    }
    return [prKey.slice(0, separator), `PR ${prKey.slice(separator + 1)}`];
}

/**
 * Browser tab title: `<PR title> · Sherpa`, or the number from the PR key until metadata arrives.
 * Never empty: without a key or metadata, the product name remains.
 */
export function documentTitleFor(prKey: string, pr: PrMeta | null): string {
    const title = pr?.title.trim() ?? '';
    const head = title === '' ? (breadcrumbFromPrKey(prKey).at(-1)?.trim() ?? '') : title;
    return head === '' ? 'Sherpa' : `${head} · Sherpa`;
}

/** Top-bar breadcrumb: once metadata arrives, the last segment links to the PR on the host. */
export function breadcrumbFor(prKey: string, pr: PrMeta | null): readonly BreadcrumbSegment[] {
    const fallback = breadcrumbFromPrKey(prKey).map((text) => ({ text, href: null }));
    if (pr === null) {
        return fallback;
    }
    // The metadata number replaces the key's number. The host segment stays as it was.
    const head = fallback.length > 1 ? fallback.slice(0, -1) : fallback;
    return [...head, { text: `PR ${pr.id}`, href: pr.url }];
}
