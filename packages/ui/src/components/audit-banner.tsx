import { PCI_FILTER_ID } from '../filters/lens-filters.js';
import type { FileFilter, FilterStats } from '../filters/lens-filters.js';
import type { ViewId } from '../session/views.js';
import { formatCount, plural } from '../text.js';
import './audit-banner.css';

/**
 * Audit-scope banner (README §Filters, SPEC §2.21): while the `pci` filter is active, the reviewer must
 * know they are not viewing the whole PR. The banner describes the filter, so it can be dismissed,
 * and has exactly one action: clear the filter.
 *
 * The component renders in the shared App-level banner slot. The slot source registry
 * owns its activation condition and priority.
 */

/** How many scope paths to list by name before the list gets too long. */
const LISTED_PATHS = 3;

/**
 * Audit scope matters where the filter actually hides files: Full diff and
 * on the route (M2-T6 showed a PCI chip in the route header, while its banner remained only
 * in Full diff. Since M2-T7 they appear together).
 */
export function auditScopeBannerVisible(
    view: ViewId,
    filterId: string,
    dismissed: boolean,
    files: number,
): boolean {
    return (view === 'diff' || view === 'route') && filterId === PCI_FILTER_ID && !dismissed && files > 0;
}

export interface AuditScopeBannerProps {
    readonly filter: FileFilter;
    readonly stats: FilterStats;
    /** Scope file paths in the current diff. README requires a list. */
    readonly paths: readonly string[];
    readonly onShowAll: () => void;
    readonly onDismiss: () => void;
}

export function AuditScopeBanner({ filter, stats, paths, onShowAll, onDismiss }: AuditScopeBannerProps) {
    const listed = paths.slice(0, LISTED_PATHS).join(', ');
    const rest = paths.length - LISTED_PATHS;
    const scope = paths.length === 0 ? '' : `Scope: ${listed}${rest > 0 ? ` and ${String(rest)} more` : ''}. `;

    return (
        <div className="audit-banner" role="status">
            <span className="audit-banner__tag">PCI DSS</span>
            <div className="audit-banner__body">
                <div className="audit-banner__line">
                    Showing only {formatCount(stats.files)}{' '}
                    {plural(stats.files, 'file', 'files', 'files')} in the audit scope,{' '}
                    {formatCount(stats.changedLines)} of {formatCount(stats.totalChangedLines)}{' '}
                    {plural(stats.totalChangedLines, 'changed line', 'changed lines', 'changed lines')}.
                    The rest is hidden, not deleted.
                </div>
                {/* README §Filters requires the scope file list and the consequence for sign-off.
                    The host's `note` adds to them and cannot replace them. */}
                <div className="audit-banner__note">
                    {scope}Changes here need an auditor sign-off. Without it, ship does not count.
                </div>
                {filter.note === null ? null : <div className="audit-banner__note">{filter.note}</div>}
            </div>
            <button type="button" className="audit-banner__action" onClick={onShowAll}>
                Show all files
            </button>
            <button
                type="button"
                className="audit-banner__dismiss"
                aria-label="Hide the audit-scope banner"
                title="Hide the banner. The filter stays on"
                onClick={onDismiss}
            >
                ✕
            </button>
        </div>
    );
}
