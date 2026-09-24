import type { PrDiff } from '@sherpa/protocol';

import { withTreeOrder } from '../../tree/file-order.js';

/** Fixture as the app sees it: `fetchReviewDiff` returns the diff in tree order. */
export function asFetched<T extends { readonly diff: PrDiff }>(data: T): T {
    return { ...data, diff: withTreeOrder(data.diff) };
}
