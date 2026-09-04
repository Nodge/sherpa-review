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

/**
 * Whether the element is near the viewport. Unlike `useOnScreen`, this flag changes both ways, letting
 * a stop remove its diff column from the DOM when the reviewer scrolls far away and restore it
 * when they scroll back (M5-T13).
 *
 * Hysteresis is required: mount at the near boundary, unmount at the far one. A single
 * boundary would make cards flicker every frame when a stop edge sits exactly on it.
 *
 * Without `IntersectionObserver` (tests, SSR, older runtimes), always consider it "near". Fall back
 * to rendering everything rather than an empty view, as in `useOnScreen`.
 */
export function useNearViewport(
    ref: RefObject<HTMLElement | null>,
    options: { readonly mountMargin: number; readonly unmountMargin: number },
): boolean {
    const { mountMargin, unmountMargin } = options;
    const [near, setNear] = useState(true);

    useEffect(() => {
        const element = ref.current;
        if (element === null || typeof IntersectionObserver === 'undefined') {
            setNear(true);
            return;
        }
        const mount = new IntersectionObserver(
            (entries) => {
                if (entries.some((entry) => entry.isIntersecting)) {
                    setNear(true);
                }
            },
            { rootMargin: `${String(mountMargin)}px` },
        );
        const unmount = new IntersectionObserver(
            (entries) => {
                if (entries.every((entry) => !entry.isIntersecting)) {
                    setNear(false);
                }
            },
            { rootMargin: `${String(unmountMargin)}px` },
        );
        mount.observe(element);
        unmount.observe(element);
        return () => {
            mount.disconnect();
            unmount.disconnect();
        };
    }, [mountMargin, ref, unmountMargin]);

    return near;
}
