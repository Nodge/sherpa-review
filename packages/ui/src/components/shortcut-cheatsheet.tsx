import { useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';

import { Icon } from '../icons/icon.tsx';
import { useEscapeLayer, useShortcutList, useShortcutRegistry } from '../shortcuts/context.tsx';
import type { Shortcut, ShortcutSection } from '../shortcuts/registry.js';
import { formatKeys, SHORTCUT_SECTIONS } from '../shortcuts/registry.js';
import { useFocusTrap } from './use-focus-trap.js';
import './shortcut-cheatsheet.css';

/**
 * `?` shortcuts sheet (SPEC §5). The registry is the sole source: commands from the active scope
 * and global commands are grouped into sections. `when()` is ignored here, because this is a reference, not a
 * list of commands available right now. Commands without shortcuts are omitted.
 */
export interface ShortcutCheatsheetProps {
    readonly onClose: () => void;
}

/** `⌘K` is the first row of "Navigation": it opens access to everything else (SPEC §2.3). */
const FIRST_ID = 'palette.open';

export function ShortcutCheatsheet({ onClose }: ShortcutCheatsheetProps) {
    const registry = useShortcutRegistry();
    const shortcuts = useShortcutList();
    const dialogRef = useRef<HTMLElement | null>(null);
    const closeRef = useRef<HTMLButtonElement | null>(null);

    useEffect(() => {
        registry?.setModalOpen(true);
        return () => {
            registry?.setModalOpen(false);
        };
    }, [registry]);
    useEffect(() => {
        closeRef.current?.focus();
    }, []);
    useFocusTrap(dialogRef);
    useEscapeLayer('modal', onClose);

    const sections = useMemo(() => cheatsheetSections(shortcuts), [shortcuts]);

    const content = (
        <div
            className="shortcut-cheatsheet__overlay"
            onMouseDown={(event) => {
                if (event.target === event.currentTarget) {
                    onClose();
                }
            }}
        >
            <section
                ref={dialogRef}
                className="shortcut-cheatsheet"
                role="dialog"
                aria-modal="true"
                aria-labelledby="shortcut-cheatsheet-title"
                tabIndex={-1}
            >
                <header className="shortcut-cheatsheet__header">
                    <h2 id="shortcut-cheatsheet-title">Keyboard shortcuts</h2>
                    <span className="shortcut-cheatsheet__spacer" />
                    <button
                        ref={closeRef}
                        type="button"
                        className="shortcut-cheatsheet__icon-button"
                        aria-label="Close shortcuts sheet"
                        title="Close · Esc"
                        onClick={onClose}
                    >
                        <Icon name="cross" size={14} />
                    </button>
                </header>

                <div className="shortcut-cheatsheet__columns">
                    {sections.map((section) => (
                        <section className="shortcut-cheatsheet__section" key={section.id}>
                            <h3>{section.label}</h3>
                            <dl>
                                {section.items.map((item) => (
                                    <div className="shortcut-cheatsheet__row" key={item.id}>
                                        <dt>
                                            <kbd className="shortcut-cheatsheet__keys">{formatKeys(item.keys)}</kbd>
                                        </dt>
                                        <dd>{item.label}</dd>
                                    </div>
                                ))}
                            </dl>
                        </section>
                    ))}
                </div>
            </section>
        </div>
    );

    return typeof document === 'undefined' ? content : createPortal(content, document.body);
}

export interface CheatsheetSection {
    readonly id: ShortcutSection;
    readonly label: string;
    readonly items: readonly Shortcut[];
}

/** Shortcuts sheet sections in `SHORTCUT_SECTIONS` order. Empty ones are hidden. */
export function cheatsheetSections(shortcuts: readonly Shortcut[]): readonly CheatsheetSection[] {
    const withKeys = shortcuts.filter((shortcut) => shortcut.keys.length > 0);
    return SHORTCUT_SECTIONS.map((section) => ({
        id: section.id,
        label: section.label,
        items: withKeys
            .filter((shortcut) => shortcut.section === section.id)
            .sort((first, second) => rank(first) - rank(second)),
    })).filter((section) => section.items.length > 0);
}

function rank(shortcut: Shortcut): number {
    return shortcut.id === FIRST_ID ? 0 : 1;
}
