import './viewed-toggle.css';

/**
 * Viewed mark: the same control for file cards and stops (SPEC §2.10):
 * a checkbox with ✓ and the label "Mark viewed / Viewed".
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
    /** Always carries progress counts for a file (SPEC §2.12), and the reason for disabling for a stop. */
    readonly title?: string | undefined;
    readonly onToggle: (viewed: boolean) => void;
}

export function ViewedToggle({ viewed, className, disabled = false, title, onToggle }: ViewedToggleProps) {
    return (
        <button
            type="button"
            className={`viewed-toggle ${className}${viewed ? ' is-viewed' : ''}`}
            aria-pressed={viewed}
            disabled={disabled}
            {...(title === undefined ? {} : { title })}
            onClick={() => {
                onToggle(!viewed);
            }}
        >
            <span className="viewed-toggle__box" aria-hidden="true">
                ✓
            </span>
            {viewed ? 'Viewed' : 'Mark viewed'}
        </button>
    );
}
