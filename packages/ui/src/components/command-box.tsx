import { useRef, useState } from 'react';

import './command-box.css';

export interface CommandBoxProps {
    readonly command: string;
    readonly hint?: string;
    readonly actionLabel?: string;
}

/** Copyable launch command with text selection as a fallback when Clipboard API is unavailable. */
export function CommandBox({ command, hint, actionLabel = 'Copy' }: CommandBoxProps) {
    const inputRef = useRef<HTMLInputElement | null>(null);
    const [feedback, setFeedback] = useState<string | null>(null);

    const selectCommand = (): void => {
        inputRef.current?.focus();
        inputRef.current?.select();
        setFeedback('Command selected. Copy it manually.');
    };

    const copy = (): void => {
        const clipboard = (navigator as unknown as { readonly clipboard?: Pick<Clipboard, 'writeText'> }).clipboard;
        if (clipboard === undefined) {
            selectCommand();
            return;
        }
        void clipboard.writeText(command).then(
            () => {
                setFeedback('Command copied.');
            },
            selectCommand,
        );
    };

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
                    {actionLabel}
                </button>
            </div>
            {hint === undefined ? null : <div className="command-box__hint">{hint}</div>}
            <span className="visually-hidden" aria-live="polite">
                {feedback}
            </span>
        </div>
    );
}
