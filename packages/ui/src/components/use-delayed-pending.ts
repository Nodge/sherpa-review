import { useEffect, useState } from 'react';

/**
 * "No spinner before 200 ms" (SPEC §3) in one utility: the pending indicator appears only
 * if the wait outlasts the delay, and hides immediately. A fast response does not flash, and a slow one does not
 * leave you wondering whether the screen is alive.
 *
 * Counts from when the flag was set in this component. This hook does not suit a wait with its own start time
 * that survives remounting (a task with `createdAt`), because it would restart
 * the countdown on each mount.
 */

/** Default threshold from SPEC §3. */
export const PENDING_DELAY_MS = 200;

export function useDelayedPending(pending: boolean, delayMs: number = PENDING_DELAY_MS): boolean {
    const [elapsed, setElapsed] = useState(pending && delayMs <= 0);
    const [tracked, setTracked] = useState(pending);

    // Flag changes update state during render rather than in an effect: hiding the indicator must not
    // cost an extra frame, and a new wait must restart the countdown from zero.
    if (tracked !== pending) {
        setTracked(pending);
        setElapsed(pending && delayMs <= 0);
    }

    useEffect(() => {
        if (!pending || delayMs <= 0) {
            return;
        }
        const timer = setTimeout(() => {
            setElapsed(true);
        }, delayMs);
        return () => {
            clearTimeout(timer);
        };
    }, [delayMs, pending]);

    return pending && elapsed;
}
