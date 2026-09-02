import { fixtureIteration } from '@sherpa/fixtures';
import type { FileDiff, Lens } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import {
    ALL_FILTER_ID,
    buildFileFilters,
    filterFiles,
    filterFragmentValue,
    filterStats,
    type FileFilter,
    findFilter,
    selectFilter,
    zeroResultText,
} from './lens-filters.js';

function file(path: string, patch: Partial<FileDiff> = {}): FileDiff {
    return {
        fileId: `f-${path}`,
        path,
        oldPath: null,
        changeType: 'modify',
        binary: false,
        generated: false,
        additions: 10,
        deletions: 2,
        patch: null,
        viewed: null,
        blameUrl: null,
        ...patch,
    };
}

function lens(id: string, label: string, paths: readonly string[], patch: Partial<Lens> = {}): Lens {
    return { id, label, paths: [...paths], available: true, note: null, zones: null, ...patch };
}

const FILES = [
    file('src/a.ts'),
    file('src/b.ts'),
    file('gen/c.ts', { generated: true, additions: 100, deletions: 0 }),
];

describe('buildFileFilters', () => {
    it('follows README §Filters order: all → mine → host lenses → generated', () => {
        const filters = buildFileFilters({
            files: FILES,
            ownership: lens('mine', 'My files', ['src/a.ts']),
            extra: [lens('pci', 'PCI DSS', ['src/b.ts'])],
        });

        expect(filters.map((filter) => filter.id)).toEqual(['all', 'mine', 'pci', 'generated']);
    });

    it('known ids have Russian labels and counts reflect the current diff', () => {
        const filters = buildFileFilters({
            files: FILES,
            ownership: lens('mine', 'My files', ['src/a.ts']),
            extra: [lens('pci', 'PCI DSS', ['src/b.ts'])],
        });

        expect(filters.map((filter) => [filter.label, filter.count])).toEqual([
            [ruDictionary['lens.all'], 3],
            ['My files · CODEOWNERS', 1],
            [ruDictionary['lens.audit']('PCI DSS'), 1],
            [ruDictionary['lens.generated'], 1],
        ]);
    });

    it('a lens count uses its intersection with the diff, not its length', () => {
        const filters = buildFileFilters({
            files: FILES,
            ownership: null,
            extra: [lens('pci', 'PCI DSS', ['src/a.ts', 'src/gone.ts', 'src/also-gone.ts'])],
        });

        expect(findFilter(filters, 'pci')?.count).toBe(1);
    });

    it('an unknown host lens enters the list with its host label unchanged', () => {
        const filters = buildFileFilters({
            files: FILES,
            ownership: null,
            extra: [lens('security-scope', 'Security scope', ['src/b.ts'])],
        });

        const unknown = findFilter(filters, 'security-scope');
        expect(unknown?.label).toBe('Security scope');
        expect(unknown?.shortLabel).toBe('Security scope');
        expect(unknown?.count).toBe(1);
    });

    it('the host cannot override synthetic all and generated filters', () => {
        const filters = buildFileFilters({
            files: FILES,
            ownership: null,
            extra: [lens('all', 'Everything', []), lens('generated', 'Robots', [])],
        });

        expect(filters.map((filter) => filter.id)).toEqual(['all', 'generated']);
        expect(findFilter(filters, 'generated')?.count).toBe(1);
    });

    it('without an ownership lens there is no mine filter', () => {
        const filters = buildFileFilters({ files: FILES, ownership: null, extra: [] });

        expect(findFilter(filters, 'mine')).toBeNull();
    });

    it('disables ownership without a zone and explains why (SPEC §4.2)', () => {
        const filters = buildFileFilters({
            files: FILES,
            ownership: lens('mine', 'My files', [], {
                available: false,
                note: 'you have no CODEOWNERS zone in this PR',
            }),
            extra: [],
        });

        const mine = findFilter(filters, 'mine');
        expect(mine?.available).toBe(false);
        expect(mine?.note).toBe('you have no CODEOWNERS zone in this PR');
    });

    it('when all files are mine the count matches all, with no preselection', () => {
        const filters = buildFileFilters({
            files: FILES,
            ownership: lens('mine', 'My files', FILES.map((item) => item.path)),
            extra: [],
        });

        expect(findFilter(filters, 'mine')?.count).toBe(3);
        expect(selectFilter(filters, null).id).toBe(ALL_FILTER_ID);
    });

    it('without generated files the generated filter is excluded', () => {
        const filters = buildFileFilters({ files: [file('src/a.ts')], ownership: null, extra: [] });

        expect(findFilter(filters, 'generated')).toBeNull();
    });

    it('an empty host lens is excluded regardless of available', () => {
        const available = buildFileFilters({
            files: FILES,
            ownership: null,
            extra: [lens('pci', 'PCI DSS', [])],
        });
        const unavailable = buildFileFilters({
            files: FILES,
            ownership: null,
            extra: [lens('pci', 'PCI DSS', [], { available: false, note: 'scope unavailable' })],
        });

        expect(findFilter(available, 'pci')).toBeNull();
        expect(findFilter(unavailable, 'pci')).toBeNull();
    });

    it('large: empty unavailable PCI is hidden while nonempty ownership and generated remain', () => {
        const data = fixtureIteration('large');
        const filters = buildFileFilters({
            files: data.diff.files,
            ownership: data.ownership,
            extra: data.extraLenses,
        });

        expect(filters.map((filter) => filter.id)).toEqual(['all', 'mine', 'generated']);
        expect(findFilter(filters, 'pci')).toBeNull();
    });

    it('edge: ownership without a zone stays disabled with the host reason', () => {
        const data = fixtureIteration('edge');
        const filters = buildFileFilters({
            files: data.diff.files,
            ownership: data.ownership,
            extra: data.extraLenses,
        });

        expect(filters.map((filter) => filter.id)).toEqual(['all', 'mine', 'generated']);
        expect(findFilter(filters, 'mine')).toMatchObject({
            available: false,
            count: 0,
            note: 'You do not own any CODEOWNERS zone touched by this PR.',
        });
    });

    it('medium: both host lenses and generated form the complete list', () => {
        const data = fixtureIteration('medium');
        const filters = buildFileFilters({
            files: data.diff.files,
            ownership: data.ownership,
            extra: data.extraLenses,
        });

        expect(filters.map((filter) => filter.id)).toEqual(['all', 'mine', 'pci', 'generated']);
        expect(filters.every((filter) => filter.available)).toBe(true);
    });

    it('available ownership with no owned files stays listed with a UI reason', () => {
        const filters = buildFileFilters({
            files: FILES,
            ownership: lens('mine', 'My files', []),
            extra: [],
        });

        expect(findFilter(filters, 'mine')).toMatchObject({
            available: false,
            count: 0,
            note: ruDictionary['lens.mine.empty'],
        });
    });
});

describe('selectFilter', () => {
    const filters = buildFileFilters({
        files: FILES,
        ownership: lens('mine', 'My files', [], { available: false, note: 'no zone' }),
        extra: [lens('pci', 'PCI DSS', ['src/b.ts'])],
    });

    it('finds a filter by id', () => {
        expect(selectFilter(filters, 'pci').id).toBe('pci');
    });

    it('garbage in the URL and a disabled item fall back to All files', () => {
        expect(selectFilter(filters, 'nonsense').id).toBe(ALL_FILTER_ID);
        expect(selectFilter(filters, 'mine').id).toBe(ALL_FILTER_ID);
        expect(selectFilter(filters, null).id).toBe(ALL_FILTER_ID);
    });
});

describe('filterFiles', () => {
    const filters = buildFileFilters({
        files: FILES,
        ownership: null,
        extra: [lens('pci', 'PCI DSS', ['src/b.ts'])],
    });

    it('All files passes the list through unchanged', () => {
        expect(filterFiles(FILES, selectFilter(filters, ALL_FILTER_ID))).toBe(FILES);
    });

    it('a lens keeps only its own files', () => {
        expect(filterFiles(FILES, selectFilter(filters, 'pci')).map((item) => item.path)).toEqual(['src/b.ts']);
    });
});

describe('filterStats', () => {
    it('counts filter files and changed lines against the whole diff', () => {
        const filters = buildFileFilters({
            files: FILES,
            ownership: null,
            extra: [lens('pci', 'PCI DSS', ['src/b.ts'])],
        });

        expect(filterStats(FILES, selectFilter(filters, 'pci'))).toEqual({
            files: 1,
            changedLines: 12,
            totalFiles: 3,
            totalChangedLines: 124,
        });
    });
});

describe('filterFragmentValue', () => {
    it('the default filter is omitted from the URL', () => {
        expect(filterFragmentValue(ALL_FILTER_ID)).toBeNull();
        expect(filterFragmentValue('pci')).toBe('pci');
    });
});

describe('zeroResultText', () => {
    function emptyFilter(id: string, label: string, note: string | null): FileFilter {
        return {
            id,
            label,
            shortLabel: label,
            count: 0,
            available: true,
            note,
            fileIds: new Set(),
        };
    }

    it('without a host reason the UI explains in its own words', () => {
        expect(zeroResultText(emptyFilter('pci', 'Файлы PCI DSS', null))).toBe(
            ruDictionary['lens.zeroResult'](ruDictionary['lens.audit']('PCI DSS')),
        );
    });

    it('the host note takes precedence over UI text', () => {
        expect(zeroResultText(emptyFilter('sox', 'SOX scope', 'SOX scope for this commit has not been published yet'))).toBe(
            'SOX scope for this commit has not been published yet',
        );
    });
});
