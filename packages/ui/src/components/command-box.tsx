import { useEffect, useRef, useState } from 'react';

import './command-box.css';

export interface CommandBoxProps {
    readonly command: string;
    readonly hint?: string;
    readonly actionLabel?: string;
}

/** How long visible feedback stays after a click, in ms. */
const FEEDBACK_MS = 2000;

const COPIED_LABEL = 'Copied';
const MANUAL_TEXT = 'The command is selected — copy it manually';

type Feedback = 'copied' | 'manual';

/** Copyable launch command with text selection as a fallback when Clipboard API is unavailable. */
export function CommandBox({ command, hint, actionLabel = 'Copy' }: CommandBoxProps) {
    const inputRef = useRef<HTMLInputElement | null>(null);
    const timerRef = useRef<number | null>(null);
    const [feedback, setFeedback] = useState<Feedback | null>(null);

    useEffect(
        () => () => {
            if (timerRef.current !== null) {
                window.clearTimeout(timerRef.current);
            }
        },
        [],
    );

    const show = (next: Feedback): void => {
        setFeedback(next);
        if (timerRef.current !== null) {
            window.clearTimeout(timerRef.current);
        }
        timerRef.current = window.setTimeout(() => {
            timerRef.current = null;
            setFeedback(null);
        }, FEEDBACK_MS);
    };

    const selectCommand = (): void => {
        inputRef.current?.focus();
        inputRef.current?.select();
        show('manual');
    };

    const copy = (): void => {
        const clipboard = (navigator as unknown as { readonly clipboard?: Pick<Clipboard, 'writeText'> }).clipboard;
        if (clipboard === undefined) {
            selectCommand();
            return;
        }
        void clipboard.writeText(command).then(() => {
            show('copied');
        }, selectCommand);
    };

    const copied = feedback === 'copied';

    return (
        <div className="command-box">
            <div className="command-box__row">
                <input
                    ref={inputRef}
                    className="command-box__command"
                    value={command}
                    readOnly
                    aria-label="Sherpa launch command"
                    onFocus={(event) => {
                        event.currentTarget.select();
                    }}
                />
                <button type="button" className="command-box__action" onClick={copy}>
                    {/* Both labels share one grid cell. The button uses the wider label and does not resize on a change. */}
                    <span className={labelClass(copied)}>{COPIED_LABEL}</span>
                    <span className={labelClass(!copied)}>{actionLabel}</span>
                </button>
            </div>
            {hint === undefined ? null : <div className="command-box__hint">{hint}</div>}
            <div
                className={feedback === 'manual' ? 'command-box__fallback' : 'visually-hidden'}
                role="status"
                aria-live="polite"
            >
                {feedback === 'copied' ? 'Command copied' : feedback === 'manual' ? MANUAL_TEXT : ''}
            </div>
        </div>
    );
}

function labelClass(visible: boolean): string {
    return visible ? 'command-box__action-label' : 'command-box__action-label command-box__action-label--ghost';
}
