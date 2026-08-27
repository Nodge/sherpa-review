import type { FileDiff, Lens } from '@sherpa/protocol';

/**
 * Shared file filter model (README §Filters, SPEC §2.7): the same model feeds
 * the toolbar select, left-panel chips, file tree and card list.
 *
 * The list is extensible: the UI counts `all` and `generated` itself, everything else arrives as host lenses.
 * An unknown lens from a future host appears in the filter when it intersects the current PR.
 */

/** Synthetic "all" filter: not a lens, with unrestricted membership. */
export const ALL_FILTER_ID = 'all';
/** Synthetic filter by `FileDiff.generated`. The flag comes from review rules, not a heuristic. */
export const GENERATED_FILTER_ID = 'generated';
export const MINE_FILTER_ID = 'mine';
export const PCI_FILTER_ID = 'pci';

/**
 * Known lens labels (decision log, 2026-08-21): the UI is in Russian, while `Lens.label` arrives
 * in English from the adapter. Unknown ids display the host label unchanged.
 */
const KNOWN_LABELS: Readonly<Record<string, string>> = {
    [ALL_FILTER_ID]: 'All files',
    [MINE_FILTER_ID]: 'My files · CODEOWNERS',
    [PCI_FILTER_ID]: 'PCI DSS files',
    [GENERATED_FILTER_ID]: 'Generated',
};

/** Short label for a left-panel chip. All filters share 290px there. */
const SHORT_LABELS: Readonly<Record<string, string>> = {
    [ALL_FILTER_ID]: 'All',
    [MINE_FILTER_ID]: 'Mine',
    [PCI_FILTER_ID]: 'PCI',
    [GENERATED_FILTER_ID]: 'Generated',
};

export interface FileFilter {
    readonly id: string;
    readonly label: string;
    /** Label for a compact chip. For unknown lenses it matches `label`. */
    readonly shortLabel: string;
    /** Live count from the current diff: membership, not lens size. */
    readonly count: number;
    /** A disabled item always explains why it is disabled (SPEC §1.1). */
    readonly available: boolean;
    readonly note: string | null;
    /** Filter files. null for `all` passes everything through. */
    readonly fileIds: ReadonlySet<string> | null;
}

export interface FileFiltersInput {
    readonly files: readonly FileDiff[];
    /** My files lens. null means the host has no ownership concept. */
    readonly ownership: Lens | null;
    readonly extra: readonly Lens[];
}

/**
 * Filter order from README §Filters: all → mine → host lenses in host order → generated.
 * Duplicate ids are dropped: the UI owns `all`/`generated`, the host cannot override them.
 *
 * Exclude host lenses other than ownership and the synthetic `generated` lens when they have zero files (decision #11).
 * Ownership remains: without a zone it uses the host reason, without owned files it uses the UI reason.
 * Nothing is preselected regardless of the list: even when all files are mine and the mine count matches
 * the "all" count (SPEC §4.2), `all` remains selected.
 */
export function buildFileFilters({ files, ownership, extra }: FileFiltersInput): readonly FileFilter[] {
    const byPath = new Map<string, string>();
    for (const file of files) {
        byPath.set(file.path, file.fileId);
    }

    const filters: FileFilter[] = [
        {
            id: ALL_FILTER_ID,
            label: label(ALL_FILTER_ID, 'All files'),
            shortLabel: shortLabel(ALL_FILTER_ID, 'All files'),
            count: files.length,
            available: true,
            note: null,
            fileIds: null,
        },
    ];

    const seen = new Set([ALL_FILTER_ID, GENERATED_FILTER_ID]);
    if (ownership !== null && !seen.has(ownership.id)) {
        seen.add(ownership.id);
        filters.push(fromOwnershipLens(ownership, byPath));
    }

    for (const item of extra) {
        if (seen.has(item.id)) {
            continue;
        }
        seen.add(item.id);
        const filter = fromLens(item, byPath);
        if (filter.count > 0) {
            filters.push(filter);
        }
    }

    const generated = new Set(files.filter((file) => file.generated).map((file) => file.fileId));
    if (generated.size > 0) {
        filters.push({
            id: GENERATED_FILTER_ID,
            label: label(GENERATED_FILTER_ID, 'Generated files'),
            shortLabel: shortLabel(GENERATED_FILTER_ID, 'Generated files'),
            count: generated.size,
            available: true,
            note: null,
            fileIds: generated,
        });
    }

    return filters;
}

function fromOwnershipLens(source: Lens, byPath: ReadonlyMap<string, string>): FileFilter {
    const filter = fromLens(source, byPath);
    if (!source.available || filter.count > 0) {
        return filter;
    }
    return {
        ...filter,
        available: false,
        note: 'no files of yours in this PR',
    };
}

function fromLens(source: Lens, byPath: ReadonlyMap<string, string>): FileFilter {
    const fileIds = new Set<string>();
    for (const path of source.paths) {
        const fileId = byPath.get(path);
        if (fileId !== undefined) {
            fileIds.add(fileId);
        }
    }

    return {
        id: source.id,
        label: label(source.id, source.label),
        shortLabel: shortLabel(source.id, source.label),
        count: fileIds.size,
        available: source.available,
        note: source.note,
        fileIds,
    };
}

function label(id: string, hostLabel: string): string {
    return KNOWN_LABELS[id] ?? hostLabel;
}

function shortLabel(id: string, hostLabel: string): string {
    return SHORT_LABELS[id] ?? KNOWN_LABELS[id] ?? hostLabel;
}

/** Filter by id. An unknown or disabled id falls back to All files. */
export function selectFilter(filters: readonly FileFilter[], id: string | null): FileFilter {
    const found = filters.find((filter) => filter.id === id);
    const all = filters.find((filter) => filter.id === ALL_FILTER_ID);
    if (all === undefined) {
        throw new Error('the filter model has no synthetic "all"');
    }
    return found?.available === true ? found : all;
}

/** Filter by id within the list rendered by the panel and select. */
export function findFilter(filters: readonly FileFilter[], id: string): FileFilter | null {
    return filters.find((filter) => filter.id === id) ?? null;
}

export function filterFiles(files: readonly FileDiff[], filter: FileFilter): readonly FileDiff[] {
    const { fileIds } = filter;
    return fileIds === null ? files : files.filter((file) => fileIds.has(file.fileId));
}

/** Counts for the audit-scope banner (README §Filters): "N files, M of K changed lines". */
export interface FilterStats {
    readonly files: number;
    readonly changedLines: number;
    readonly totalFiles: number;
    readonly totalChangedLines: number;
}

export function filterStats(files: readonly FileDiff[], filter: FileFilter): FilterStats {
    const inside = filterFiles(files, filter);
    return {
        files: inside.length,
        changedLines: changedLines(inside),
        totalFiles: files.length,
        totalChangedLines: changedLines(files),
    };
}

function changedLines(files: readonly FileDiff[]): number {
    return files.reduce((sum, file) => sum + file.additions + file.deletions, 0);
}

/**
 * The `filter` parameter value in the URL fragment: All files omits the parameter entirely,
 * a link to the default view should match a link with no filter.
 */
export function filterFragmentValue(id: string): string | null {
    return id === ALL_FILTER_ID ? null : id;
}

/**
 * An empty result explains itself (SPEC §2.7). The host provides `note` for this,
 * and if it is absent, the UI explains in its own words.
 */
export function zeroResultText(filter: FileFilter): string {
    return filter.note ?? `No files in the "${filter.label}" filter in this PR.`;
}
