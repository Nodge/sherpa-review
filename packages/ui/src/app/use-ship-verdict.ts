import type { PublishResult, ReviewerVerdict, Verdict } from '@sherpa/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';

import { publishReview } from '../api.js';
import { isShipVerdict } from '../components/review-action-model.js';
import type { ShipVerdictEvent, ShipVerdictWatch } from '../components/ship-verdict-banner.tsx';
import { INITIAL_SHIP_VERDICT_WATCH, observeShipVerdicts } from '../components/ship-verdict-banner.tsx';

export interface UseShipVerdictResult {
    readonly shipVerdict: ShipVerdictEvent | null;
    readonly shipVerdictNow: number;
    readonly setShipVerdict: (event: ShipVerdictEvent | null) => void;
    readonly publishHere: (verdict: Verdict) => Promise<PublishResult>;
}

/**
 * A ship from someone else: verdicts arrive in the metadata snapshot without timestamps, so
 * record when they appear. The first snapshot of a tab session is the baseline and shows no banner.
 */
export function useShipVerdict(
    verdicts: readonly ReviewerVerdict[] | null,
    token: string,
): UseShipVerdictResult {
    const verdictWatch = useRef<ShipVerdictWatch>(INITIAL_SHIP_VERDICT_WATCH);
    const [shipVerdict, setShipVerdict] = useState<ShipVerdictEvent | null>(null);
    const [shipVerdictNow, setShipVerdictNow] = useState(() => Date.now());
    useEffect(() => {
        if (verdicts === null) {
            return;
        }
        const observed = observeShipVerdicts(verdictWatch.current, verdicts, Date.now());
        verdictWatch.current = observed.watch;
        if (observed.event !== null) {
            setShipVerdict(observed.event);
            setShipVerdictNow(observed.event.observedAt);
        }
    }, [verdicts]);
    const publishHere = useCallback(
        async (verdict: Verdict): Promise<PublishResult> => {
            const result = await publishReview(token, verdict);
            if (isShipVerdict(verdict)) {
                // Our own verdict is about to appear in metadata. There is nobody to notify with a banner.
                verdictWatch.current = { ...verdictWatch.current, ownShipPending: true };
            }
            return result;
        },
        [token],
    );
    // After a minute, "just now" becomes "N min ago". The banner time updates automatically.
    useEffect(() => {
        if (shipVerdict === null) {
            return;
        }
        const timer = window.setInterval(() => {
            setShipVerdictNow(Date.now());
        }, 60_000);
        return () => {
            window.clearInterval(timer);
        };
    }, [shipVerdict]);

    return { shipVerdict, shipVerdictNow, setShipVerdict, publishHere };
}
