import type { DigestAnchorView, DigestClaimView, DigestModel } from '../../route/digest.js';
import { anchorLabel, claimLabel } from '../../route/digest.js';
import { formatCount, plural } from '../../text.js';

/**
 * Behavioural digest card (README §2): a header with an assertion count, a note about
 * hidden test code, Show/Hide test code, rows of "category chip + assertion + anchor"
 * and an `uncovered` footer for changed behaviour left without an assertion.
 *
 * The component computes and loads nothing. Its model comes from `route/digest.ts`, and the view handles
 * anchor jumps. Test code expands into real file cards below this card,
 * so the global diff mode (SPEC §2.6) applies to it automatically.
 */

export const DIGEST_NOTE = 'test code is hidden, the assertions are the contract';
export const UNCOVERED_NOTE = 'changed behaviour without an assertion, check it by hand';
/** The anchor is shown but has no jump target because no route card contains its line. */
export const ANCHOR_OFFSCREEN = 'this line is not on the route, open the file in the full diff';

export interface TestDigestProps {
    readonly model: DigestModel;
    /** Test code expanded below the digest. */
    readonly shown: boolean;
    readonly onToggle: () => void;
    /** Number of the stop's test files hidden by the digest, used for an accurate button label. */
    readonly hiddenFiles: number;
    /** Whether a card anywhere in the route renders this line. */
    readonly anchorReachable: (anchor: DigestAnchorView) => boolean;
    readonly onOpenAnchor: (anchor: DigestAnchorView) => void;
}

export function TestDigest({
    model,
    shown,
    onToggle,
    hiddenFiles,
    anchorReachable,
    onOpenAnchor,
}: TestDigestProps) {
    return (
        <section className="digest" aria-label="Behavioural test digest">
            <div className="digest__head">
                <span className="digest__title">
                    Behavioural digest · {formatCount(model.total)}{' '}
                    {plural(model.total, 'assertion', 'assertions', 'assertions')}
                </span>
                {shown ? null : <span className="digest__note">{DIGEST_NOTE}</span>}
                <span className="digest__spacer" />
                <button
                    type="button"
                    className="digest__toggle"
                    aria-expanded={shown}
                    title={
                        shown
                            ? 'Hides the test-file diff below the digest again'
                            : `Expands the test-file diff below the digest: ${formatCount(hiddenFiles)} ${plural(hiddenFiles, 'file', 'files', 'files')}`}
                    }
                    onClick={onToggle}
                >
                    {shown ? 'Hide test code' : 'Show test code'}
                </button>
            </div>

            {model.rows.map((claim, index) => (
                <ClaimRow
                    key={`${claim.kind}\u0000${String(index)}`}
                    claim={claim}
                    anchorReachable={anchorReachable}
                    onOpenAnchor={onOpenAnchor}
                />
            ))}

            {model.footer.length === 0 ? null : (
                <div className="digest__footer">
                    <p className="digest__footer-note">{UNCOVERED_NOTE}</p>
                    {model.footer.map((claim, index) => (
                        <ClaimRow
                            key={`uncovered\u0000${String(index)}`}
                            claim={claim}
                            anchorReachable={anchorReachable}
                            onOpenAnchor={onOpenAnchor}
                        />
                    ))}
                </div>
            )}

            {model.dropped === 0 ? null : (
                <p className="digest__dropped">
                    {formatCount(model.dropped)}{' '}
                    {plural(model.dropped, 'assertion dropped', 'assertions dropped', 'assertions dropped')} because
                    the anchor did not find a test
                </p>
            )}
        </section>
    );
}

function ClaimRow({
    claim,
    anchorReachable,
    onOpenAnchor,
}: {
    claim: DigestClaimView;
    anchorReachable: (anchor: DigestAnchorView) => boolean;
    onOpenAnchor: (anchor: DigestAnchorView) => void;
}) {
    const anchor = claim.anchor;
    return (
        <div className={`digest__row digest__row--${claim.kind}`}>
            <span className={`digest__chip digest__chip--${claim.kind}`}>{claimLabel(claim.kind)}</span>
            <span className="digest__text">{claim.text}</span>
            {anchor === null ? null : anchorReachable(anchor) ? (
                <button
                    type="button"
                    className="digest__anchor"
                    title={`${anchor.path}:${String(anchor.line)}`}
                    onClick={() => {
                        onOpenAnchor(anchor);
                    }}
                >
                    {anchorLabel(anchor)}
                </button>
            ) : (
                <span className="digest__anchor digest__anchor--off" title={`${anchor.path} — ${ANCHOR_OFFSCREEN}`}>
                    {anchorLabel(anchor)}
                </span>
            )}
        </div>
    );
}
