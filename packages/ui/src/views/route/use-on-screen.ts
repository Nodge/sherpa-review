import type { RefObject } from 'react';
import { useEffect, useState } from 'react';

/**
 * Whether the element has appeared on screen. Once `true`, always `true`. This flag lets a stop
 * request parsing of its files and render cards beyond the first five (SPEC §2.9),
 * and there is no point in undoing that.
 *
 * Without `IntersectionObserver` (tests, older runtimes), consider everything visible. Fall back
 * to rendering everything rather than an empty view.
 */
export function useOnScreen(ref: RefObject<HTMLElement | null>, rootMargin = '800px'): boolean {
    const [seen, setSeen] = useState(false);

    useEffect(() => {
        if (seen) {
            return;
        }
        const element = ref.current;
        if (element === null || typeof IntersectionObserver === 'undefined') {
            setSeen(true);
            return;
        }
        const observer = new IntersectionObserver(
            (entries) => {
                if (entries.some((entry) => entry.isIntersecting)) {
                    setSeen(true);
                    observer.disconnect();
                }
            },
            { rootMargin },
        );
        observer.observe(element);
        return () => {
            observer.disconnect();
        };
    }, [ref, rootMargin, seen]);

    return seen;
}
