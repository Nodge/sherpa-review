import { updateFragment } from '../fragment.js';
import type { Feedback } from './file-card.tsx';

/**
 * Both the full diff list and route cards need a file link: build the same URL
 * for both, or links from the 2 views would open different things.
 *
 * Use a fragment parameter, not a `#file-…` anchor: the fragment holds the access token
 * (rpc-design §8), so replacing it entirely would produce a link without the token.
 */

/** A file link is the current address plus the `file` fragment parameter. */
export async function copyFileLink(fileId: string): Promise<Feedback> {
    return copy(updateFragment(window.location.hash, { file: fileId, thread: null }), 'File link copied.');
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
