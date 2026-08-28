import { useState } from 'react';

import { Icon } from '../../icons/icon.tsx';
import type { FileReadState } from '../../progress/read-state.js';
import type { RouteFileGroup } from '../../route/route-model.js';
import { formatCount, plural } from '../../text.js';

/**
 * Stop file chips (README §1): name, path, counts for this stop and a read-state
 * box. Clicking goes to the file card in the right column (SPEC §2.11).
 *
 * With more than 12 files, show 8 and a "N more files" expander (SPEC §2.9). The narrow column
 * must not become a file list two screens long.
 */

const CHIPS_LIMIT = 12;
const CHIPS_SHOWN = 8;

export interface FileChipsProps {
    readonly files: readonly RouteFileGroup[];
    readonly readStateOf: (fileId: string) => FileReadState;
    readonly onOpen: (fileId: string) => void;
}

export function FileChips({ files, readStateOf, onOpen }: FileChipsProps) {
    const [expanded, setExpanded] = useState(false);
    const clamped = files.length > CHIPS_LIMIT && !expanded;
    const shown = clamped ? files.slice(0, CHIPS_SHOWN) : files;
    const hidden = files.length - shown.length;

    return (
        <div className="route-chips">
            {shown.map((group) => (
                <FileChip key={group.fileId} group={group} read={readStateOf(group.fileId)} onOpen={onOpen} />
            ))}
            {hidden === 0 ? null : (
                <button
                    type="button"
                    className="route-chips__more"
                    onClick={() => {
                        setExpanded(true);
                    }}
                >
                    {formatCount(hidden)} more {plural(hidden, 'file', 'files', 'files')}
                </button>
            )}
        </div>
    );
}

function FileChip({
    group,
    read,
    onOpen,
}: {
    group: RouteFileGroup;
    read: FileReadState;
    onOpen: (fileId: string) => void;
}) {
    return (
        <button
            type="button"
            className={`route-chip${read.state === 'read' ? ' is-read' : ''}`}
            title="Go to this file in the stop's diff"
            onClick={() => {
                onOpen(group.fileId);
            }}
        >
            <span className="route-chip__name">{group.name}</span>
            <span className="route-chip__path">{group.dir}</span>
            <span className="route-chip__spacer" />
            <span className="route-chip__add">+{formatCount(group.additions)}</span>
            <span className="route-chip__del">−{formatCount(group.deletions)}</span>
            {/* The three-state box uses the shared `readStateOf`. The tooltip always includes counts (SPEC §2.12). */}
            <span className={`route-chip__read route-chip__read--${read.state}`} title={read.tooltip}>
                {read.state === 'read' ? <Icon name="check" size={9} /> : null}
            </span>
        </button>
    );
}
