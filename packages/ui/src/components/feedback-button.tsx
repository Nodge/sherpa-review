import type {
    UiFeedbackChannel,
    UiFeedbackRequest,
    UiFeedbackResponse,
    UiRoutePhase,
    WorkerStatus,
} from '@sherpa/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { Translate } from '../i18n/index.js';
import { useT } from '../i18n/index.js';
import { useEscapeLayer } from '../shortcuts/context.tsx';

export interface FeedbackPreviewContext {
    readonly uiVersion: string;
    readonly prKey: string;
    readonly view: string;
    readonly routePhase: UiRoutePhase;
    readonly worker: WorkerStatus;
}

type IssuesChannel = Extract<UiFeedbackChannel, { kind: 'issues' }>;

export interface FeedbackButtonProps {
    readonly channel: UiFeedbackChannel;
    readonly context: FeedbackPreviewContext;
    readonly onSend: (request: UiFeedbackRequest) => Promise<UiFeedbackResponse>;
}

/** Top-bar Feedback button. Link channels open externally, issues channels open a form. */
export function FeedbackButton({ channel, context, onSend }: FeedbackButtonProps) {
    if (channel.kind === 'link') {
        return (
            <a className="ctl ctl--ghost ctl--topbar feedback-button" href={channel.url} target="_blank" rel="noreferrer">
                Feedback
            </a>
        );
    }
    return <FeedbackForm channel={channel} context={context} onSend={onSend} />;
}

interface FeedbackFormProps {
    readonly channel: IssuesChannel;
    readonly context: FeedbackPreviewContext;
    readonly onSend: (request: UiFeedbackRequest) => Promise<UiFeedbackResponse>;
}

/** Feedback popover form that preserves text on error. */
function FeedbackForm({ channel, context, onSend }: FeedbackFormProps) {
    const t = useT();
    const [open, setOpen] = useState(false);
    const [text, setText] = useState('');
    const [includeContext, setIncludeContext] = useState(true);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [created, setCreated] = useState<{ key: string | null; url: string | null } | null>(null);
    const [serverUnavailable, setServerUnavailable] = useState<string | null>(null);
    const [copyStatus, setCopyStatus] = useState<string | null>(null);
    const wrapperRef = useRef<HTMLDivElement | null>(null);
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);

    // A channel without an unavailability reason is still unavailable. The form must not offer to send.
    const unavailableReason = channel.available ? serverUnavailable : (channel.reason ?? t('feedback.unavailable'));

    // An unavailable response applies to one attempt. The channel checks availability on each submission,
    // so closing the form restores the send action and preserves the text.
    const close = useCallback((): void => {
        setOpen(false);
        setError(null);
        setCopyStatus(null);
        setServerUnavailable(null);
        if (created !== null) {
            setText('');
            setCreated(null);
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
        document.addEventListener('mousedown', closeOutside);
        return () => {
            document.removeEventListener('mousedown', closeOutside);
        };
    }, [close, open]);
    useEscapeLayer('popover', close, open);

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
                setServerUnavailable(response.message ?? t('feedback.unavailable'));
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
            setCopyStatus(t('feedback.copied'));
        } catch {
            textareaRef.current?.select();
            setCopyStatus(t('feedback.copyFailed'));
        }
    };

    return (
        <div ref={wrapperRef} className="feedback-wrap">
            <button
                type="button"
                className="ctl ctl--ghost ctl--topbar feedback-button"
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
                <div className="feedback-popover" role="dialog" aria-label={t('feedback.aria')}>
                    {created === null ? (
                        <form
                            onSubmit={(event) => {
                                event.preventDefault();
                                void submit();
                            }}
                        >
                            <div className="feedback-popover__title">{t('feedback.title')}</div>
                            <label className="feedback-popover__label" htmlFor="sherpa-feedback-text">
                                {t('feedback.placeholder')}
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
                                {t('feedback.attachContext')}
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
                                        className="ctl ctl--primary feedback-popover__primary"
                                        disabled={submitting || text.trim() === ''}
                                        title={text.trim() === '' ? t('feedback.send.disabled') : undefined}
                                    >
                                        {submitting ? <span className="feedback-popover__spinner" aria-hidden="true" /> : null}
                                        <span>{t('feedback.send')}</span>
                                    </button>
                                ) : (
                                    <button
                                        type="button"
                                        className="ctl ctl--primary feedback-popover__primary"
                                        disabled={text.trim() === ''}
                                        title={text.trim() === '' ? t('feedback.copy.disabled') : undefined}
                                        onClick={() => {
                                            void copyText();
                                        }}
                                    >
                                        {t('feedback.copy')}
                                    </button>
                                )}
                                <button type="button" className="ctl ctl--ghost" onClick={close}>
                                    {t('feedback.cancel')}
                                </button>
                            </div>
                            {channel.discussionUrl === null ? null : (
                                <p className="feedback-popover__chat">
                                    {t('feedback.chat')}{' '}
                                    <a href={channel.discussionUrl} target="_blank" rel="noreferrer">
                                        {t('feedback.chat.link')}
                                    </a>
                                </p>
                            )}
                        </form>
                    ) : (
                        <div className="feedback-popover__success" role="status">
                            <div className="feedback-popover__title">{t('feedback.thanks')}</div>
                            <p>
                                {t('feedback.ticket')}
                                {created.url === null ? (
                                    created.key === null ? null : <> {created.key}</>
                                ) : (
                                    <>
                                        {' '}
                                        <a href={created.url} target="_blank" rel="noreferrer">
                                            {created.key ?? created.url}
                                        </a>
                                    </>
                                )}
                                .
                            </p>
                            <button type="button" className="ctl ctl--primary feedback-popover__primary" onClick={close}>
                                {t('feedback.close')}
                            </button>
                        </div>
                    )}
                </div>
            ) : null}
        </div>
    );
}

function ContextPreview({ context, included }: { context: FeedbackPreviewContext; included: boolean }) {
    const t = useT();
    return (
        <div className="feedback-context" aria-label={t('feedback.context.aria')}>
            {included ? (
                <>
                    <div>UI {context.uiVersion}</div>
                    <div>{context.prKey}</div>
                    <div>
                        {context.view} · {context.routePhase}
                    </div>
                    <div>{workerPreview(context.worker, t)}</div>
                </>
            ) : (
                <div>{t('feedback.context.none')}</div>
            )}
        </div>
    );
}

function workerPreview(worker: WorkerStatus, t: Translate): string {
    if (worker.kind === 'never') {
        return t('feedback.worker.none');
    }
    return t(
        'feedback.worker',
        worker.harness ?? t('feedback.worker.unknownHarness'),
        worker.model ?? t('feedback.worker.unknownModel'),
        t(worker.kind === 'connected' ? 'feedback.worker.connected' : 'feedback.worker.disconnected'),
    );
}
