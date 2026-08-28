import { useState } from 'react';

import { updateFragment } from '../../fragment.js';
import { ComposerIconSprite } from '../../icons/composer-icons.tsx';
import './gallery.css';
import type { GalleryState } from './states.tsx';
import { GALLERY_STATES } from './states.tsx';

/**
 * State gallery: named states on the left, deterministic rendering of the selected one on the right.
 * No server or token, only fixtures and static props.
 */
export function Gallery({ initialId }: { initialId: string | null }) {
    const [selectedId, setSelectedId] = useState(initialId ?? GALLERY_STATES[0]?.id ?? '');
    const selected = GALLERY_STATES.find((state) => state.id === selectedId) ?? GALLERY_STATES[0];

    const select = (id: string): void => {
        setSelectedId(id);
        // State in the URL: a link to a specific state can be shared and reopened.
        history.replaceState(null, '', updateFragment(window.location.hash, { state: id }));
    };

    return (
        <div className="gallery">
            <ComposerIconSprite />
            <nav className="gallery__sidebar" aria-label="States">
                <div className="gallery__brand">State gallery</div>
                {groupBy(GALLERY_STATES).map(([group, states]) => (
                    <section key={group} className="gallery__group">
                        <h2 className="gallery__group-title">{group}</h2>
                        {states.map((state) => (
                            <button
                                key={state.id}
                                type="button"
                                className="gallery__item"
                                aria-current={state.id === selected?.id}
                                onClick={() => {
                                    select(state.id);
                                }}
                            >
                                {state.title}
                            </button>
                        ))}
                    </section>
                ))}
            </nav>

            <div className="gallery__stage">
                {selected === undefined ? null : (
                    <>
                        <div className="gallery__stage-title">
                            {selected.group} · {selected.title}
                            <code className="gallery__stage-id">{selected.id}</code>
                        </div>
                        {/* key: changing the state remounts the render, so initial props (defaultMenuOpen, etc.) apply again. */}
                        <div className="gallery__canvas" key={selected.id}>
                            {selected.render()}
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}

function groupBy(states: readonly GalleryState[]): [string, GalleryState[]][] {
    const groups = new Map<string, GalleryState[]>();
    for (const state of states) {
        const bucket = groups.get(state.group);
        if (bucket === undefined) {
            groups.set(state.group, [state]);
        } else {
            bucket.push(state);
        }
    }
    return [...groups];
}
