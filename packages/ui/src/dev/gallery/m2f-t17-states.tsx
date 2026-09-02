import { fixtureIteration } from '@sherpa/fixtures';
import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';

import { FilterSelect } from '../../components/filter-select.tsx';
import {
    buildFileFilters,
    filterFiles,
    findFilter,
    MINE_FILTER_ID,
    selectFilter,
} from '../../filters/lens-filters.js';
import { readStateOf } from '../../progress/read-state.js';
import { FilePanel } from '../../tree/file-panel.tsx';

const EDGE = fixtureIteration('edge');
const FILES = EDGE.diff.files.filter((file) => !file.generated);
const FILTERS = buildFileFilters({
    files: FILES,
    ownership: EDGE.ownership,
    extra: fixtureIteration('large').extraLenses,
});
const MINE = findFilter(FILTERS, MINE_FILTER_ID);
const READ_STATE = new Map(FILES.map((file) => [file.fileId, readStateOf({ file, record: null })]));

export interface M2FT17GalleryState {
    readonly id: string;
    readonly title: string;
    readonly render: () => ReactNode;
}

export const M2F_T17_STATES: readonly M2FT17GalleryState[] = [
    {
        id: 'filters-zero-lenses',
        title: 'empty lenses hidden, "My files" disabled',
        render: () => <ZeroLensFiltersState />,
    },
];

function ZeroLensFiltersState() {
    const [filterId, setFilterId] = useState('all');
    const active = selectFilter(FILTERS, filterId);
    const selectRoot = useRef<HTMLDivElement | null>(null);

    // The display shows the dropdown contents immediately, without a separate click.
    useEffect(() => {
        const button = selectRoot.current?.querySelector<HTMLButtonElement>('.filter-select__button');
        if (button?.getAttribute('aria-expanded') !== 'true') {
            button?.click();
        }
    }, []);

    return (
        <div className="gallery__viewport gallery-zero-filters">
            <FilePanel
                files={filterFiles(FILES, active)}
                filters={FILTERS}
                activeFilter={active}
                onFilter={setFilterId}
                pciFileIds={new Set()}
                mineFileIds={MINE?.fileIds ?? null}
                readState={READ_STATE}
                route={null}
                activeFileId={null}
                onOpenFile={() => undefined}
                onToggleViewed={() => undefined}
                writeError={null}
                outline={null}
                onOpenHunk={() => undefined}
            />
            <section className="gallery-zero-filters__select" ref={selectRoot}>
                <h2>Filter select</h2>
                <FilterSelect filters={FILTERS} active={active} onSelect={setFilterId} />
            </section>
        </div>
    );
}
