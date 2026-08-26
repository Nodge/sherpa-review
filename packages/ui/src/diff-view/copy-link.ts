import { updateFragment } from '../fragment.js';
import type { Feedback } from './file-card.tsx';

/**
 * Both the full diff list and route stop cards need file links. The address
 * is built the same way so links from both views open the same thing.
 */

/** A file link is the current address plus the `file` fragment parameter. */
export async function copyFileLink(fileId: string): Promise<Feedback> {
    return copy(updateFragment(window.location.hash, { file: fileId, thread: null }), 'File link copied.');
}

/** A route stop link uses the fragment's `stop` parameter. */
export async function copyStopLink(stopId: string): Promise<string> {
    return copy(stopFragment(window.location.hash, stopId), 'Stop link copied.');
}

/**
 * A fragment containing a stop link. Use a parameter, not a `#stop-…` anchor: the fragment holds
 * the access token (rpc-design §8), and overwriting it would produce a link without the token.
 */
export function stopFragment(hash: string, stopId: string): string {
    return updateFragment(hash, { stop: stopId, file: null, thread: null });
}

async function copy(hash: string, done: string): Promise<string> {
    const url = new URL(window.location.href);
    url.hash = hash;
    try {
        await navigator.clipboard.writeText(url.toString());
    } catch {
        return 'The browser could not copy the link. Copy the page address manually.';
    }
    return done;
}
