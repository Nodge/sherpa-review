import type { PrMeta } from '@sherpa/protocol';

import type { FileFilter } from '../filters/lens-filters.js';
import { formatCount, plural } from '../text.js';
import './pr-header.css';

/**
 * PR header (README §1): metadata row `+N −M · K files · branch · PCI DSS chip`, title and author.
 * The component is shared with the route view in M2, so it knows nothing about
 * data loading or the chip destination. Both come through props.
 *
 * The snapshot selector on the right side of the header comes in M4.
 */

export interface PrHeaderProps {
    readonly pr: PrMeta;
    readonly additions: number;
    readonly deletions: number;
    readonly files: number;
    /**
     * Audit-scope lens for the shortcut chip. null means no lens or an unpublished scope
     * (`available: false`). In that case there is no chip, and the select item stays disabled.
     */
    readonly pci: FileFilter | null;
    readonly pciActive: boolean;
    readonly onTogglePci: () => void;
}

export function PrHeader({ pr, additions, deletions, files, pci, pciActive, onTogglePci }: PrHeaderProps) {
    return (
        <header className="pr-header">
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
                {pci === null ? null : (
                    <>
                        <Separator />
                        {/* SPEC §4.2: the scope exists but this PR does not touch it. The chip is disabled
                            with a count of 0. The select item remains selectable. */}
                        <button
                            type="button"
                            className={`pr-header__pci${pciActive ? ' is-active' : ''}`}
                            disabled={pci.count === 0}
                            aria-pressed={pciActive}
                            title={
                                pci.count === 0
                                    ? 'this PR has no audit-scope files'
                                    : 'Show only the PCI DSS audit-scope files'
                            }
                            onClick={onTogglePci}
                        >
                            PCI DSS · {pci.count} {plural(pci.count, 'file', 'files', 'files')}
                        </button>
                    </>
                )}
            </div>

            <h1 className="pr-header__title">{pr.title}</h1>

            <div className="pr-header__author">
                <span className="pr-header__avatar" aria-hidden="true">
                    {initials(pr.author.displayName ?? pr.author.login)}
                </span>
                <span>{pr.author.login}</span>
                <Separator />
                <span>{pr.statusLabel}</span>
            </div>
        </header>
    );
}

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
