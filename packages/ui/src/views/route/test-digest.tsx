import type {
    DigestAnchorView,
    DigestClaimView,
    DigestModel,
    DigestTestCodeLocation,
} from '../../route/digest.js';
import type { MessageKey } from '../../i18n/index.js';
import { useT } from '../../i18n/index.js';
import { Markdown } from '../../markdown/markdown.tsx';
import { anchorLabel, claimLabel } from '../../route/digest.js';

/**
 * Behavioural digest card (docs/design/README.md §2): header with assertion count, controls for
 * hidden test code or a link to its entry, rows of "category chip + assertion + anchor"
 * and an `uncovered` footer for changed behaviour left without an assertion.
 *
 * The component computes and loads nothing. Its model comes from `route/digest.ts`, and the view handles
 * anchor jumps. Test code expands into real file cards below this card,
 * so the global diff mode (docs/design/SPEC-elements.md §2.6) applies to it automatically.
 */

export const DIGEST_NOTE: MessageKey = 'digest.note';
export const UNCOVERED_NOTE: MessageKey = 'digest.uncovered';
/** The anchor is shown but has no jump target because no route card contains its line. */
export const ANCHOR_OFFSCREEN: MessageKey = 'digest.anchorOffscreen';

export interface TestDigestProps {
    readonly model: DigestModel;
    /** Test code expanded below the digest. */
    readonly shown: boolean;
    readonly onToggle: () => void;
    /** Number of the stop's test files hidden by the digest, used for an accurate button label. */
    readonly hiddenFiles: number;
    /** Test code destination when the current stop has nothing to hide after applying the lens. */
    readonly location: DigestTestCodeLocation | null;
    /** Whether a card anywhere in the route renders this line. */
    readonly anchorReachable: (anchor: DigestAnchorView) => boolean;
    readonly onOpenAnchor: (anchor: DigestAnchorView) => void;
}

export function TestDigest({
    model,
    shown,
    onToggle,
    hiddenFiles,
    location,
    anchorReachable,
    onOpenAnchor,
}: TestDigestProps) {
    const t = useT();
    return (
        <section className="digest" aria-label={t('digest.aria')}>
            <div className="digest__head">
                <span className="digest__title">{t('digest.title', model.total)}</span>
                {hiddenFiles === 0 ? (
                    location === null ? null : (
                        <button
                            type="button"
                            className="ctl ctl--link-muted digest__anchor digest__location"
                            title={`${location.anchor.path}:${String(location.anchor.line)}`}
                            onClick={() => {
                                onOpenAnchor(location.anchor);
                            }}
                        >
                            {location.label}
                        </button>
                    )
                ) : (
                    <>
                        {shown ? null : <span className="digest__note">{t(DIGEST_NOTE)}</span>}
                        <span className="digest__spacer" />
                        <button
                            type="button"
                            className="ctl ctl--ghost ctl--compact digest__toggle"
                            aria-expanded={shown}
                            title={shown ? t('digest.hide.title') : t('digest.show.title', hiddenFiles)}
                            onClick={onToggle}
                        >
                            {shown ? t('digest.hide') : t('digest.show')}
                        </button>
                    </>
                )}
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
                    <p className="digest__footer-note">{t(UNCOVERED_NOTE)}</p>
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
                <p className="digest__dropped">{t('digest.dropped', model.dropped)}</p>
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
    const t = useT();
    const anchor = claim.anchor;
    return (
        <div className={`digest__row digest__row--${claim.kind}`}>
            <span className={`digest__chip digest__chip--${claim.kind}`}>{t(claimLabel(claim.kind))}</span>
            <span className="digest__text">
                <Markdown text={claim.text} profile="route" />
            </span>
            {anchor === null ? null : anchorReachable(anchor) ? (
                <button
                    type="button"
                    className="ctl ctl--link-muted digest__anchor"
                    title={`${anchor.path}:${String(anchor.line)}`}
                    onClick={() => {
                        onOpenAnchor(anchor);
                    }}
                >
                    {anchorLabel(anchor)}
                </button>
            ) : (
                <span className="digest__anchor digest__anchor--off" title={`${anchor.path} — ${t(ANCHOR_OFFSCREEN)}`}>
                    {anchorLabel(anchor)}
                </span>
            )}
        </div>
    );
}
