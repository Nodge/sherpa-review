import type { FileDiff, PrChecks, PrMeta } from '@sherpa/protocol';
import type { ReactNode, Ref } from 'react';

import type { FileFilter } from '../filters/lens-filters.js';
import type { MessageKey } from '../i18n/index.js';
import { relativeTime, useFormat, useLocale, useT } from '../i18n/index.js';
import './pr-header.css';

/**
 * PR header (docs/design/README.md §1): metadata row `+N −M · K files · branch · PCI DSS chip`, title and author.
 * This shared component also appears in the route view, so it knows nothing about
 * data loading or the chip destination. Both come through props.
 *
 * The header's right side is the `aside` slot (docs/design/README.md §1), which holds the pill-shaped
 * snapshot indicator with an iteration picker menu. Without iterations, the slot is empty.
 *
 * The `overview` variant has its own layout from the prototype Overview screen (`Sherpa.dc.html:523-529`):
 * PR number in the metadata row, a larger title, author without an avatar, time, branches and check
 * status, and a non-clickable audit scope chip. The `aside` slot sits in the author row here. This
 * variant has no separate bottom row.
 */

/** Diff totals for header metadata. `null` means the diff has not arrived yet (skeleton, empty frame). */
export interface PrHeaderCounts {
    readonly additions: number;
    readonly deletions: number;
    readonly files: number;
}

export interface PrHeaderDefaultProps {
    readonly variant?: 'default';
    readonly ref?: Ref<HTMLElement>;
    readonly pr: PrMeta;
    readonly counts: PrHeaderCounts | null;
    /** Audit scope lens for the shortcut chip, visible only when `available && count > 0`. */
    readonly pci: FileFilter | null;
    readonly pciActive: boolean;
    readonly onTogglePci: () => void;
    /** Right edge of the header's bottom row, used for the snapshot pill in the route. */
    readonly aside?: ReactNode;
}

export interface PrHeaderOverviewProps {
    readonly variant: 'overview';
    readonly ref?: Ref<HTMLElement>;
    readonly pr: PrMeta;
    /** Diff counters. null means the diff has not arrived yet and the metadata row only has the PR number. */
    readonly counts: PrHeaderCounts | null;
    /**
     * Audit scope lens. This chip is only a marker. The filter shortcut lives in Full diff.
     * The marker has no counter or disabled state, so show it only when the lens
     * works and the PR actually contains its files. Otherwise a PR outside the audit scope
     * would receive an unrelated label.
     */
    readonly pci: FileFilter | null;
    /** Reference time for relative timestamps, injected to keep the gallery deterministic. */
    readonly now: number;
    /** Right edge of the author row. Also holds the snapshot pill (docs/design/README.md §1). */
    readonly aside?: ReactNode;
}

export type PrHeaderProps = PrHeaderDefaultProps | PrHeaderOverviewProps;

/** Diff totals for the metadata row. The same numbers appear in every view. */
export function prHeaderCounts(diff: { readonly files: readonly FileDiff[] }): PrHeaderCounts {
    let additions = 0;
    let deletions = 0;
    for (const file of diff.files) {
        additions += file.additions;
        deletions += file.deletions;
    }
    return { additions, deletions, files: diff.files.length };
}

export function PrHeader(props: PrHeaderProps) {
    return props.variant === 'overview' ? <OverviewHeader {...props} /> : <DefaultHeader {...props} />;
}

function DefaultHeader({ ref, pr, counts, pci, pciActive, onTogglePci, aside = null }: PrHeaderDefaultProps) {
    const t = useT();
    const { count } = useFormat();
    return (
        <header className="pr-header" ref={ref}>
            <div className="pr-header__meta">
                {counts === null ? null : (
                    <>
                        <span className="pr-header__add">+{count(counts.additions)}</span>
                        <span className="pr-header__del">−{count(counts.deletions)}</span>
                        <Separator />
                        <span>{t('pr.files', counts.files)}</span>
                        <Separator />
                    </>
                )}
                <span className="pr-header__branches">
                    {pr.toBranch} ← {pr.fromBranch}
                </span>
                {/* Decision #11: an empty or unavailable PCI scope leaves no chip in the header. */}
                {pci === null || !pci.available || pci.count === 0 ? null : (
                    <>
                        <Separator />
                        <button
                            type="button"
                            className={`pr-header__pci${pciActive ? ' is-active' : ''}`}
                            aria-pressed={pciActive}
                            title={t('pr.pci.title')}
                            onClick={onTogglePci}
                        >
                            {t('pr.pci.label', pci.count)}
                        </button>
                    </>
                )}
            </div>

            <h1 className="pr-header__title">{pr.title}</h1>

            <div className="pr-header__bottom">
                <div className="pr-header__author">
                    <span className="pr-header__avatar" aria-hidden="true">
                        {initials(pr.author.displayName ?? pr.author.login)}
                    </span>
                    <span>{pr.author.login}</span>
                    <Separator />
                    <span>{pr.statusLabel}</span>
                </div>
                {aside === null ? null : <div className="pr-header__aside">{aside}</div>}
            </div>
        </header>
    );
}

function OverviewHeader({ ref, pr, counts, pci, now, aside = null }: PrHeaderOverviewProps) {
    const t = useT();
    const locale = useLocale();
    const { count } = useFormat();
    return (
        <header className="pr-header pr-header--overview" ref={ref}>
            <div className="pr-header__meta">
                <span>PR {pr.id}</span>
                {counts === null ? null : (
                    <>
                        <Separator />
                        <span className="pr-header__add">+{count(counts.additions)}</span>
                        <span className="pr-header__del">−{count(counts.deletions)}</span>
                        <Separator />
                        <span>{t('pr.files', counts.files)}</span>
                    </>
                )}
                {pci === null || !pci.available || pci.count === 0 ? null : (
                    <>
                        <Separator />
                        <span className="pr-header__pci-tag">PCI DSS</span>
                    </>
                )}
            </div>

            <h1 className="pr-header__title">{pr.title}</h1>

            <div className="pr-header__author">
                <span>{pr.author.login}</span>
                <Separator />
                <span>{relativeTime(pr.updatedAt, now, locale)}</span>
                <Separator />
                <span className="pr-header__branches">
                    {pr.toBranch} ← {pr.fromBranch}
                </span>
                {pr.checks === null ? null : (
                    <>
                        <Separator />
                        <span className={`pr-header__checks is-${pr.checks}`}>{t(CHECKS_LABELS[pr.checks])}</span>
                    </>
                )}
                {aside === null ? null : <div className="pr-header__aside">{aside}</div>}
            </div>
        </header>
    );
}

/** Check status in words. The host returns three states, `null` omits the segment entirely. */
const CHECKS_LABELS: Readonly<Record<PrChecks, MessageKey>> = {
    passed: 'pr.checks.passed',
    failed: 'pr.checks.failed',
    pending: 'pr.checks.pending',
};

function Separator() {
    return (
        <span className="pr-header__separator" aria-hidden="true">
            ·
        </span>
    );
}

/** One or two letters for the avatar circle: first and last name, or the first letters of the login. */
function initials(name: string): string {
    const parts = name.split(/[\s._-]+/).filter((part) => part !== '');
    if (parts.length >= 2) {
        return `${first(parts[0])}${first(parts[1])}`.toUpperCase();
    }
    return name.slice(0, 2).toUpperCase();
}

function first(part: string | undefined): string {
    return part?.slice(0, 1) ?? '';
}
