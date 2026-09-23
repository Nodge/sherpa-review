import { useT } from '../i18n/index.js';
import { Icon } from '../icons/icon.tsx';
import { useReadOnlyIteration, useReadOnlyReason } from '../iterations/read-only.tsx';

/**
 * "Viewed" mark is one control for a file card and a stop (docs/design/SPEC-elements.md §2.10):
 * checkbox with a label in the file header and a filled pill toggle in the stop header
 * (docs/design/SPEC-changes-2026-09-20.md §5, "Checkbox" and "Viewed toggle" rows).
 *
 * The control has two states. The three-state reading progress indicator (§2.12) is a separate entity:
 * it lives in the tree and on file chips, and the button has no "partial" state.
 *
 * This is a toggle, not an actual checkbox: `aria-pressed` announces the state.
 */
export interface ViewedToggleProps {
    readonly viewed: boolean;
    /** Call site class: indicator in the stop header and plain row in the file header differ. */
    readonly className: string;
    /** Box with a label (file header) or pill toggle (stop header). */
    readonly variant?: 'checkbox' | 'toggle';
    readonly disabled?: boolean;
    /**
     * For a file, always holds progress numbers (docs/design/SPEC-elements.md §2.12). For a stop, the reason it is disabled.
     * When reading a previous iteration, its reason replaces this.
     */
    readonly title?: string | undefined;
    readonly onToggle: (viewed: boolean) => void;
}

export function ViewedToggle({
    viewed,
    className,
    variant = 'checkbox',
    disabled = false,
    title,
    onToggle,
}: ViewedToggleProps) {
    const t = useT();
    // Marks live in the active iteration: the control is visible but cannot be pressed in a previous one.
    const readOnly = useReadOnlyIteration();
    const readOnlyReason = useReadOnlyReason();
    const effectiveDisabled = readOnly || disabled;
    const effectiveTitle = readOnly ? readOnlyReason : title;
    const variantClass = variant === 'toggle' ? 'ctl ctl--toggle' : 'ctl-checkbox';
    return (
        <button
            type="button"
            className={`viewed-toggle ${variantClass} ${className}${viewed ? ' is-on' : ''}`}
            aria-pressed={viewed}
            disabled={effectiveDisabled}
            {...(effectiveTitle === undefined ? {} : { title: effectiveTitle })}
            onClick={() => {
                onToggle(!viewed);
            }}
        >
            {variant === 'toggle' ? (
                viewed ? (
                    <Icon name="check" size={13} />
                ) : null
            ) : (
                <span className="ctl-checkbox__box" aria-hidden="true">
                    <Icon name="check" size={9} />
                </span>
            )}
            {viewed ? t('viewed.on') : t('viewed.off')}
        </button>
    );
}
