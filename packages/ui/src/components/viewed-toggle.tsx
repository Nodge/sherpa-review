import { useT } from '../i18n/index.js';
import { Icon } from '../icons/icon.tsx';
import { useReadOnlyIteration, useReadOnlyReason } from '../iterations/read-only.tsx';
import './viewed-toggle.css';

/**
 * Viewed mark: the same control for file cards and stops (SPEC §2.10):
 * a checkbox with an icon and the "Mark viewed / Viewed" label.
 *
 * The control has two states. The three-state reading progress indicator (§2.12) is a separate entity:
 * it lives in the tree and on file chips, and the button has no "partial" state.
 *
 * This is a toggle, not an actual checkbox: `aria-pressed` announces the state.
 */
export interface ViewedToggleProps {
    readonly viewed: boolean;
    /** Call-site class: the pill in the stop header differs from the plain row in the file header. */
    readonly className: string;
    readonly disabled?: boolean;
    /**
     * For a file, always carries progress counts (SPEC §2.12), for a stop, the reason it is disabled.
     * When reading a previous iteration, its reason replaces this.
     */
    readonly title?: string | undefined;
    readonly onToggle: (viewed: boolean) => void;
}

export function ViewedToggle({ viewed, className, disabled = false, title, onToggle }: ViewedToggleProps) {
    const t = useT();
    // Marks live in the active iteration: the control is visible but cannot be pressed in a previous one.
    const readOnly = useReadOnlyIteration();
    const readOnlyReason = useReadOnlyReason();
    const effectiveDisabled = readOnly || disabled;
    const effectiveTitle = readOnly ? readOnlyReason : title;
    return (
        <button
            type="button"
            className={`viewed-toggle ${className}${viewed ? ' is-viewed' : ''}`}
            aria-pressed={viewed}
            disabled={effectiveDisabled}
            {...(effectiveTitle === undefined ? {} : { title: effectiveTitle })}
            onClick={() => {
                onToggle(!viewed);
            }}
        >
            <span className="viewed-toggle__box" aria-hidden="true">
                <Icon name="check" size={9} />
            </span>
            {viewed ? t('viewed.on') : t('viewed.off')}
        </button>
    );
}
