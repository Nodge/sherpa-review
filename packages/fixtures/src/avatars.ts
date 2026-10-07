import type { Comment, ReviewUser, Thread } from '@sherpa/protocol';

/**
 * Photos of people for the state gallery. The gallery works offline, so the photos are data URIs of small
 * SVGs rather than host URLs. The `ReviewUser` schema rejects these URLs, so fixtures returned
 * by the fixture host never contain them. Only the gallery substitutes them.
 */
export const GALLERY_AVATAR_PHOTOS: readonly [string, string, string] = [
    portrait('#3f6fb5', '#f1c7a1', '#1f3557'),
    portrait('#8a5a9e', '#e7b48f', '#3c2346'),
    portrait('#3b8a6e', '#c99572', '#1d4436'),
];

/** A photo that will not load: corrupt PNG bytes, no network. `<img>` gets `error` immediately. */
export const GALLERY_AVATAR_BROKEN = 'data:image/png;base64,AAAA';

/** The same user with a photo. */
export function withAvatar(user: ReviewUser, avatarUrl: string): ReviewUser {
    return { ...user, avatarUrl };
}

/** Threads with photos substituted by login for authors in `photos`. Other authors stay unchanged. */
export function withAvatars(threads: readonly Thread[], photos: ReadonlyMap<string, string>): Thread[] {
    const swap = (comment: Comment): Comment => {
        const photo = photos.get(comment.author.login);
        return {
            ...comment,
            author: photo === undefined ? comment.author : withAvatar(comment.author, photo),
            replies: comment.replies.map(swap),
        };
    };
    return threads.map((thread) => ({ ...thread, root: swap(thread.root) }));
}

/** A silhouette on a coloured background: head and shoulders, a 100×100 square clipped by the avatar box shape. */
function portrait(background: string, skin: string, clothes: string): string {
    const svg = [
        '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">',
        `<rect width="100" height="100" fill="${background}"/>`,
        `<ellipse cx="50" cy="96" rx="34" ry="26" fill="${clothes}"/>`,
        `<circle cx="50" cy="42" r="20" fill="${skin}"/>`,
        '</svg>',
    ].join('');
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
