import type { PrChecks, PrMeta } from '@sherpa/protocol';
import type { ReactNode, Ref } from 'react';

import type { FileFilter } from '../filters/lens-filters.js';
import { formatCount, plural } from '../text.js';
import { relativeTime } from '../threads/relative-time.js';
import './pr-header.css';

/**
 * PR header (README §1): metadata row `+N −M · K files · branch · PCI DSS chip`, title and author.
 * The component is shared with the route view in M2, so it knows nothing about
 * data loading or the chip destination. Both come through props.
 *
 * The right side of the header is the `aside` slot. Route puts the snapshot pill there (README §1),
 * Full diff leaves it empty. Snapshot selection arrives in M4.
 *
 * The `overview` variant has its own layout from the prototype Overview screen (`Sherpa.dc.html:523-529`):
 * PR number in the metadata row, a larger title, author without an avatar, time, branches and check
 * status, and a non-clickable audit scope chip. The `aside` slot sits in the author row here. This
 * variant has no separate bottom row.
 */

export interface PrHeaderDefaultProps {
    readonly variant?: 'default';
    readonly ref?: Ref<HTMLElement>;
    readonly pr: PrMeta;
    readonly additions: number;
    readonly deletions: number;
    readonly files: number;
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
    readonly counts: { readonly additions: number; readonly deletions: number; readonly files: number } | null;
    /**
     * Audit scope lens. This chip is only a marker. The filter shortcut lives in Full diff.
     * The marker has no counter or disabled state, so show it only when the lens
     * works and the PR actually contains its files. Otherwise a PR outside the audit scope
     * would receive an unrelated label.
     */
    readonly pci: FileFilter | null;
    /** Reference time for relative timestamps, injected to keep the gallery deterministic. */
    readonly now: number;
    /** Right end of the author row, also holds the snapshot pill (README §1). */
    readonly aside?: ReactNode;
}

export type PrHeaderProps = PrHeaderDefaultProps | PrHeaderOverviewProps;

export function PrHeader(props: PrHeaderProps) {
    return props.variant === 'overview' ? <OverviewHeader {...props} /> : <DefaultHeader {...props} />;
}

function DefaultHeader({
    ref,
    pr,
    additions,
    deletions,
    files,
    pci,
    pciActive,
    onTogglePci,
    aside = null,
}: PrHeaderDefaultProps) {
    return (
        <header className="pr-header" ref={ref}>
            <div className="pr-header__meta">
                <span className="pr-header__add">+{formatCount(additions)}</span>
                <span className="pr-header__del">−{formatCount(deletions)}</span>
                <Separator />
                <span>
                    {formatCount(files)} {plural(files, 'file', 'files', 'files')}
                </span>
                <Separator />
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
                            title="Show only files in the PCI DSS audit scope"
                            onClick={onTogglePci}
                        >
                            PCI DSS · {pci.count} {plural(pci.count, 'file', 'files', 'files')}
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
    return (
        <header className="pr-header pr-header--overview" ref={ref}>
            <div className="pr-header__meta">
                <span>PR {pr.id}</span>
                {counts === null ? null : (
                    <>
                        <Separator />
                        <span className="pr-header__add">+{formatCount(counts.additions)}</span>
                        <span className="pr-header__del">−{formatCount(counts.deletions)}</span>
                        <Separator />
                        <span>
                            {formatCount(counts.files)} {plural(counts.files, 'file', 'files', 'files')}
                        </span>
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
                <span>{relativeTime(pr.updatedAt, now)}</span>
                <Separator />
                <span className="pr-header__branches">
                    {pr.toBranch} ← {pr.fromBranch}
                </span>
                {pr.checks === null ? null : (
                    <>
                        <Separator />
                        <span className={`pr-header__checks is-${pr.checks}`}>{CHECKS_LABELS[pr.checks]}</span>
                    </>
                )}
                {aside === null ? null : <div className="pr-header__aside">{aside}</div>}
            </div>
        </header>
    );
}

/** Check status in words. The host returns three states, `null` omits the segment entirely. */
const CHECKS_LABELS: Readonly<Record<PrChecks, string>> = {
    passed: 'checks passed',
    failed: 'checks failed',
    pending: 'checks running',
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
