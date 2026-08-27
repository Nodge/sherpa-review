import type {
    UiFeedbackAvailability,
    UiFeedbackRequest,
    UiFeedbackResponse,
    UiRoutePhase,
    WorkerStatus,
} from '@sherpa/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';

export interface FeedbackPreviewContext {
    readonly uiVersion: string;
    readonly prKey: string;
    readonly view: string;
    readonly routePhase: UiRoutePhase;
    readonly worker: WorkerStatus;
}

export interface FeedbackButtonProps {
    readonly availability: UiFeedbackAvailability;
    readonly context: FeedbackPreviewContext;
    readonly onSend: (request: UiFeedbackRequest) => Promise<UiFeedbackResponse>;
}

/** Top bar button and feedback form that preserves text on error. */
export function FeedbackButton({ availability, context, onSend }: FeedbackButtonProps) {
    const [open, setOpen] = useState(false);
    const [text, setText] = useState('');
    const [includeContext, setIncludeContext] = useState(true);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [created, setCreated] = useState<{ key: string; url: string } | null>(null);
    const [serverUnavailable, setServerUnavailable] = useState<string | null>(null);
    const [copyStatus, setCopyStatus] = useState<string | null>(null);
    const wrapperRef = useRef<HTMLDivElement | null>(null);
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);

    const unavailableReason = availability.available ? serverUnavailable : availability.reason;

    const close = useCallback((): void => {
        setOpen(false);
        setError(null);
        setCopyStatus(null);
        if (created !== null) {
            setText('');
            setCreated(null);
            setServerUnavailable(null);
        }
    }, [created]);

    useEffect(() => {
        if (!open) {
            return;
        }
        const closeOutside = (event: MouseEvent): void => {
            if (event.target instanceof Node && !wrapperRef.current?.contains(event.target)) {
                close();
            }
        };
        const closeOnEscape = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') {
                close();
            }
        };
        document.addEventListener('mousedown', closeOutside);
        document.addEventListener('keydown', closeOnEscape);
        return () => {
            document.removeEventListener('mousedown', closeOutside);
            document.removeEventListener('keydown', closeOnEscape);
        };
    }, [close, open]);

    useEffect(() => {
        if (open && created === null) {
            textareaRef.current?.focus();
        }
    }, [created, open]);

    const submit = async (): Promise<void> => {
        if (submitting || text.trim() === '' || unavailableReason !== null) {
            return;
        }
        setSubmitting(true);
        setError(null);
        setCopyStatus(null);
        try {
            const response = await onSend({
                text,
                includeContext,
                context: includeContext
                    ? { view: context.view, routePhase: context.routePhase, uiVersion: context.uiVersion }
                    : null,
            });
            if (response.outcome === 'unavailable') {
                setServerUnavailable(response.message ?? 'The feedback channel is unavailable right now.');
                return;
            }
            if (response.issueKey === null || response.issueUrl === null) {
                setError('The server created an issue but returned no URL. Your text has been saved, try sending it again.');
                return;
            }
            setCreated({ key: response.issueKey, url: response.issueUrl });
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setSubmitting(false);
        }
    };

    const copyText = async (): Promise<void> => {
        if (text.trim() === '') {
            return;
        }
        try {
            await navigator.clipboard.writeText(text);
            setCopyStatus('Text copied.');
        } catch {
            textareaRef.current?.select();
            setCopyStatus('Could not copy automatically. The text is selected.');
        }
    };

    return (
        <div ref={wrapperRef} className="feedback-wrap">
            <button
                type="button"
                className="ghost-button feedback-button"
                aria-haspopup="dialog"
                aria-expanded={open}
                onClick={() => {
                    if (open) {
                        close();
                    } else {
                        setOpen(true);
                    }
                }}
            >
                Feedback
            </button>
            {open ? (
                <div className="feedback-popover" role="dialog" aria-label="Send feedback">
                    {created === null ? (
                        <form
                            onSubmit={(event) => {
                                event.preventDefault();
                                void submit();
                            }}
                        >
                            <div className="feedback-popover__title">Feedback on Sherpa</div>
                            <label className="feedback-popover__label" htmlFor="sherpa-feedback-text">
                                What happened or what is missing
                            </label>
                            <textarea
                                ref={textareaRef}
                                id="sherpa-feedback-text"
                                className="feedback-popover__textarea"
                                value={text}
                                maxLength={20_000}
                                required
                                aria-invalid={error !== null}
                                disabled={submitting}
                                onChange={(event) => {
                                    setText(event.target.value);
                                    setError(null);
                                    setCopyStatus(null);
                                }}
                            />
                            <label className="feedback-popover__checkbox">
                                <input
                                    type="checkbox"
                                    checked={includeContext}
                                    disabled={submitting || unavailableReason !== null}
                                    onChange={(event) => {
                                        setIncludeContext(event.target.checked);
                                    }}
                                />
                                Attach the context
                            </label>
                            <ContextPreview context={context} included={includeContext && unavailableReason === null} />
                            {unavailableReason === null ? null : (
                                <p className="feedback-popover__unavailable">{unavailableReason}</p>
                            )}
                            {error === null ? null : (
                                <p className="feedback-popover__error" role="alert">
                                    {error}
                                </p>
                            )}
                            {copyStatus === null ? null : (
                                <p className="feedback-popover__copy-status" role="status">
                                    {copyStatus}
                                </p>
                            )}
                            <div className="feedback-popover__actions">
                                {unavailableReason === null ? (
                                    <button
                                        type="submit"
                                        className="feedback-popover__primary"
                                        disabled={submitting || text.trim() === ''}
                                        title={text.trim() === '' ? 'Write the feedback text.' : undefined}
                                    >
                                        {submitting ? <span className="feedback-popover__spinner" aria-hidden="true" /> : null}
                                        <span>Send</span>
                                    </button>
                                ) : (
                                    <button
                                        type="button"
                                        className="feedback-popover__primary"
                                        disabled={text.trim() === ''}
                                        title={text.trim() === '' ? 'Write the feedback text first.' : undefined}
                                        onClick={() => {
                                            void copyText();
                                        }}
                                    >
                                        Copy the text
                                    </button>
                                )}
                                <button type="button" className="feedback-popover__secondary" onClick={close}>
                                    Cancel
                                </button>
                            </div>
                        </form>
                    ) : (
                        <div className="feedback-popover__success" role="status">
                            <div className="feedback-popover__title">Thanks for the feedback</div>
                            <p>
                                Issue created{' '}
                                <a href={created.url} target="_blank" rel="noreferrer">
                                    {created.key}
                                </a>
                                .
                            </p>
                            <button type="button" className="feedback-popover__primary" onClick={close}>
                                Close
                            </button>
                        </div>
                    )}
                </div>
            ) : null}
        </div>
    );
}

function ContextPreview({ context, included }: { context: FeedbackPreviewContext; included: boolean }) {
    return (
        <div className="feedback-context" aria-label="Feedback context">
            {included ? (
                <>
                    <div>UI {context.uiVersion}</div>
                    <div>{context.prKey}</div>
                    <div>
                        {context.view} · {context.routePhase}
                    </div>
                    <div>{workerPreview(context.worker)}</div>
                </>
            ) : (
                <div>No context will be attached.</div>
            )}
        </div>
    );
}

function workerPreview(worker: WorkerStatus): string {
    if (worker.kind === 'never') {
        return 'Worker: not registered';
    }
    const status = worker.kind === 'connected' ? 'connected' : 'disconnected';
    return `Worker: ${worker.harness ?? 'harness unknown'} · ${worker.model ?? 'model unknown'} · ${status}`;
}
