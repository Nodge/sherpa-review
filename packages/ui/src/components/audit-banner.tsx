import { PCI_FILTER_ID } from '../filters/lens-filters.js';
import type { FileFilter, FilterStats } from '../filters/lens-filters.js';
import { useT } from '../i18n/index.js';
import { Icon } from '../icons/icon.tsx';
import type { ViewId } from '../session/views.js';
import './audit-banner.css';

/**
 * Audit scope banner (docs/design/README.md §Filters, docs/design/SPEC-elements.md §2.21):
 * while the `pci` filter is active, the reviewer must know they are not seeing the entire PR. The banner describes the filter, so it can be dismissed,
 * and has exactly one action: clear the filter.
 *
 * The component renders in the shared App-level banner slot. The slot source registry
 * owns its activation condition and priority.
 */

/** How many scope paths to list by name before the list gets too long. */
const LISTED_PATHS = 3;

/**
 * Audit scope matters where the filter actually hides files: Full diff and
 * in the route view. The PCI chip in the route header and its banner appear together in both views.
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
    /** Scope file paths in the current diff. `docs/design/README.md` §Filters requires the list. */
    readonly paths: readonly string[];
    readonly onShowAll: () => void;
    readonly onDismiss: () => void;
}

export function AuditScopeBanner({ filter, stats, paths, onShowAll, onDismiss }: AuditScopeBannerProps) {
    const t = useT();
    const listed = paths.slice(0, LISTED_PATHS).join(', ');
    const rest = paths.length - LISTED_PATHS;
    const scope =
        paths.length === 0 ? '' : rest > 0 ? t('audit.scope.more', listed, rest) : t('audit.scope', listed);

    return (
        <div className="audit-banner" role="status">
            <span className="audit-banner__tag">PCI DSS</span>
            <div className="audit-banner__body">
                <div className="audit-banner__line">
                    {t('audit.line', stats.files, stats.changedLines, stats.totalChangedLines)}
                </div>
                {/* docs/design/README.md §Filters always requires the scope file list and the sign-off consequence.
                    The host's `note` adds to them and cannot replace them. */}
                <div className="audit-banner__note">
                    {scope}
                    {t('audit.note')}
                </div>
                {filter.note === null ? null : <div className="audit-banner__note">{filter.note}</div>}
            </div>
            <button type="button" className="audit-banner__action" onClick={onShowAll}>
                {t('lens.showAll')}
            </button>
            <button
                type="button"
                className="audit-banner__dismiss"
                aria-label={t('audit.dismiss')}
                title={t('audit.dismiss.title')}
                onClick={onDismiss}
            >
                <Icon name="cross" size={14} />
            </button>
        </div>
    );
}
