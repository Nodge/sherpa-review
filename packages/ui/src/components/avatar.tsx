import { useState } from 'react';

import './avatar.css';

export interface AvatarProps {
    /** Caller box class, which owns size, shape, background and initials font. */
    readonly className: string;
    /** Name used to derive initials. */
    readonly name: string;
    readonly url: string | null;
    /** `pair` uses the PR header rule, see `pairInitials`. */
    readonly initialsRule?: 'words' | 'pair';
}

/**
 * A person or bot avatar is always round. Use a photo when the host provides one, otherwise initials. Initials
 * always sit under the photo, so the box stays filled during loading and after a load failure. The name always
 * appears beside it or in the control label, so the avatar is decorative.
 */
export function Avatar({ className, name, url, initialsRule = 'words' }: AvatarProps) {
    // Remember URLs that failed to load. Do not request them again during this component's lifetime.
    const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
    return (
        <span className={`avatar ${className}`} aria-hidden="true">
            {initialsRule === 'pair' ? pairInitials(name) : initials(name)}
            {url === null || failed.has(url) ? null : (
                <img
                    className="avatar__photo"
                    src={url}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    referrerPolicy="no-referrer"
                    onError={() => {
                        setFailed((prev) => new Set(prev).add(url));
                    }}
                />
            )}
        </span>
    );
}

/** One or two letters: the first letters of the first two words in the name or login. */
export function initials(name: string): string {
    return name
        .split(/[\s._-]+/u)
        .filter((part) => part !== '')
        .slice(0, 2)
        .map((part) => part[0]?.toUpperCase() ?? '')
        .join('');
}

/** Two letters: the first letters of the first two words, or the first two letters of a single-word name. */
export function pairInitials(name: string): string {
    const parts = name.split(/[\s._-]+/u).filter((part) => part !== '');
    if (parts.length >= 2) {
        return initials(name);
    }
    return name.slice(0, 2).toUpperCase();
}
