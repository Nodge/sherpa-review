import type { Thread } from '@sherpa/protocol';
import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { CommentSourceChips } from '../components/toolbar-controls.tsx';
import { relativeTime, useFormat, useLocale, useT } from '../i18n/index.js';
import { Icon } from '../icons/icon.tsx';
import type { SessionStore } from '../session/session-store.js';
import { CommentComposer } from '../threads/comment-composer.tsx';
import type { ComposerTransport } from '../threads/composer.js';
import { useThreadPin } from '../iterations/thread-pin.tsx';
import { authorName, flattenThread } from '../threads/model.js';
import type { ComposerSnapshot, ThreadStore } from '../threads/store.js';
import { openReply, ThreadPinChip } from '../threads/thread-list.tsx';
import { Markdown } from '../markdown/markdown.tsx';
import type { DiscussionParticipant } from './overview-model.js';
import { bodyNeedsExpand, discussionSummary } from './overview-model.js';
import './overview-discussion.css';

/** The card shows no more participant rows beyond this limit, then "N more" (docs/design/SPEC-additions-2026-08-26.md §1e item 3). */
const PARTICIPANT_ROWS = 6;

export interface OverviewDiscussionProps {
    /** `null`: no threads yet because the host is unavailable, loading is in progress or loading failed. */
    readonly threads: readonly Thread[] | null;
    /** Files in the rendered diff determine whether a thread is at code or "outside the diff". */
    readonly fileIds: ReadonlySet<string>;
    readonly session: SessionStore;
    readonly store: ThreadStore;
    readonly transport: ComposerTransport;
    readonly now: number;
    readonly loading: boolean;
    readonly error: string | null;
    /** Opens the PR comment modal and returns focus to the button on close. */
    readonly onWritePrComment?: ((returnFocus: () => void) => void) | undefined;
    /** Initial "outside the diff" fold state: collapsed in the application, sometimes expanded in the gallery. */
    readonly outsideOpenByDefault?: boolean | undefined;
}

/**
 * Discussion card in Overview (docs/design/SPEC-additions-2026-08-26.md §1e): a summary and entry point, not a feed. Thread
 * bodies live at code. Only threads outside the diff expand in the card because there is nowhere else
 * to read them. Bot threads collapse into one row per bot and never show their bodies.
 */
export function OverviewDiscussion({
    threads,
    fileIds,
    session,
    store,
    transport,
    now,
    loading,
    error,
    onWritePrComment,
    outsideOpenByDefault = false,
}: OverviewDiscussionProps) {
    const t = useT();
    const format = useFormat();
    const { threadsShow } = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
    const [allParticipants, setAllParticipants] = useState(false);
    const [outsideOpen, setOutsideOpen] = useState(outsideOpenByDefault);
    const writeButtonRef = useRef<HTMLButtonElement | null>(null);
    const summary = useMemo(
        () => discussionSummary(threads ?? EMPTY_THREADS, fileIds, threadsShow),
        [fileIds, threads, threadsShow],
    );

    const openAuthorLens = (login: string): void => {
        session.setThreadAuthor(login);
        session.setView('diff');
    };

    const footer = (
        <div className="discussion-card__footer">
            <button
                type="button"
                className="ctl ctl--link discussion-card__all"
                onClick={() => {
                    // The label promises all threads, so clear the participant lens set by the row above.
                    session.setThreadAuthor(null);
                    session.setView('diff');
                }}
            >
                {t('overview.discussion.allThreads')}
                <Icon name="chev-right" size={13} />
            </button>
            <span className="discussion-card__spacer" />
            <button
                ref={writeButtonRef}
                type="button"
                className="ctl ctl--ghost ctl--compact discussion-card__write"
                disabled={onWritePrComment === undefined}
                onClick={() => {
                    onWritePrComment?.(() => {
                        writeButtonRef.current?.focus();
                    });
                }}
            >
                {t('overview.discussion.writePr')}
            </button>
        </div>
    );

    if (threads === null) {
        return (
            <section className="discussion-card">
                <DiscussionHead title={t('overview.discussion')} />
                <p className="discussion-card__empty">
                    {loading ? t('overview.discussion.loading') : (error ?? t('overview.discussion.empty'))}
                </p>
                {footer}
            </section>
        );
    }

    if (summary.total === 0) {
        return (
            <section className="discussion-card">
                <DiscussionHead title={t('overview.discussion')} />
                <p className="discussion-card__empty">{t('overview.discussion.empty')}</p>
                {footer}
            </section>
        );
    }

    const shown = allParticipants ? summary.participants : summary.participants.slice(0, PARTICIPANT_ROWS);
    const rest = summary.participants.length - shown.length;

    return (
        <section className="discussion-card">
            <DiscussionHead
                title={t('overview.discussion')}
                counts={t('overview.discussion.summary', summary.total, summary.open)}
            />
            <div className="discussion-card__filters">
                <CommentSourceChips show={threadsShow} counts={summary.counts} onChange={session.setThreadsShow} />
            </div>
            <div className="discussion-card__people">
                {shown.map((participant) => (
                    <ParticipantRow
                        key={participant.login}
                        participant={participant}
                        now={now}
                        onOpen={openAuthorLens}
                    />
                ))}
                {rest === 0 ? null : (
                    <button
                        type="button"
                        className="ctl ctl--link discussion-card__more"
                        onClick={() => {
                            setAllParticipants(true);
                        }}
                    >
                        {t('overview.discussion.more', rest)}
                    </button>
                )}
            </div>
            <div className="discussion-card__outside">
                {/* Nothing to expand: keep the row in place without making it look clickable. */}
                {summary.outside.length === 0 ? (
                    <div className="discussion-card__outside-toggle is-static">
                        <Icon name="chev-down" size={13} className="discussion-card__outside-chev is-collapsed" />
                        {t('overview.discussion.outside')}
                        <span className="discussion-card__outside-count">{format.count(0)}</span>
                        <span className="discussion-card__spacer" />
                        <span className="discussion-card__outside-hint">
                            {t('overview.discussion.outside.empty')}
                        </span>
                    </div>
                ) : (
                    <button
                        type="button"
                        className="discussion-card__outside-toggle"
                        aria-expanded={outsideOpen}
                        onClick={() => {
                            setOutsideOpen(!outsideOpen);
                        }}
                    >
                        <Icon
                            name="chev-down"
                            size={13}
                            className={`discussion-card__outside-chev${outsideOpen ? '' : ' is-collapsed'}`}
                        />
                        {t('overview.discussion.outside')}
                        <span className="discussion-card__outside-count">{format.count(summary.outside.length)}</span>
                        <span className="discussion-card__spacer" />
                        <span className="discussion-card__outside-hint">{t('overview.discussion.outside.hint')}</span>
                    </button>
                )}
                {outsideOpen && summary.outside.length > 0 ? (
                    <div className="discussion-card__outside-list">
                        {summary.outside.map((thread) => (
                            <OutsideThreadCard
                                key={thread.id}
                                thread={thread}
                                store={store}
                                transport={transport}
                                now={now}
                            />
                        ))}
                    </div>
                ) : null}
            </div>
            {footer}
        </section>
    );
}

function DiscussionHead({ title, counts }: { title: string; counts?: string }) {
    return (
        <header className="discussion-card__head">
            <h2 className="discussion-card__title">{title}</h2>
            {counts === undefined ? null : <span className="discussion-card__counts">{counts}</span>}
        </header>
    );
}

function ParticipantRow({
    participant,
    now,
    onOpen,
}: {
    participant: DiscussionParticipant;
    now: number;
    onOpen: (login: string) => void;
}) {
    const t = useT();
    const format = useFormat();
    const locale = useLocale();
    const openLabel =
        participant.open === 0
            ? t('overview.discussion.participant.none')
            : t('overview.discussion.participant.open', participant.open);
    const last =
        participant.lastActivity === null
            ? null
            : t('overview.discussion.participant.last', relativeTime(participant.lastActivity, now, locale));
    return (
        <button
            type="button"
            className="discussion-participant"
            aria-label={t('overview.discussion.participant.aria', participant.name)}
            onClick={() => {
                onOpen(participant.login);
            }}
        >
            <span className={`discussion-participant__avatar${participant.bot ? ' is-bot' : ''}`} aria-hidden="true">
                {initials(participant.name)}
            </span>
            <span className="discussion-participant__body">
                <span className="discussion-participant__name-line">
                    <span className="discussion-participant__name">{participant.name}</span>
                    {participant.bot ? <span className="discussion-participant__bot">bot</span> : null}
                </span>
                <span className="discussion-participant__sub">
                    {last === null ? openLabel : `${openLabel} · ${last}`}
                </span>
            </span>
            <span className={`discussion-participant__count${participant.open > 0 ? ' is-open' : ''}`}>
                {format.count(participant.threads)}
            </span>
            <Icon name="chev-right" size={13} className="discussion-participant__chev" />
        </button>
    );
}

/**
 * A thread outside the diff in a 360px column: markdown is allowed, but headings use ordinary bold text,
 * and links and code blocks use one truncated line (§1e item 4). The card keeps replies
 * collapsed into an "N replies" counter. There is no tree as at code, but replies must stay accessible because
 * this is the only place to read replies outside the diff, including a newly written one.
 */
function OutsideThreadCard({
    thread,
    store,
    transport,
    now,
}: {
    thread: Thread;
    store: ThreadStore;
    transport: ComposerTransport;
    now: number;
}) {
    const t = useT();
    const locale = useLocale();
    const [expanded, setExpanded] = useState(false);
    const [repliesOpen, setRepliesOpen] = useState(false);
    const composer = useComposerSnapshot(store, `reply:${thread.id}`);
    // A thread on a removed file may have been written in a previous iteration. There is nowhere else to read it,
    // so the "show at old commit" action also lives here (docs/design/SPEC-elements.md §2.17).
    const pinned = useThreadPin(thread);
    const clampable = bodyNeedsExpand(thread.root.body);
    const clamped = clampable && !expanded;
    const state = thread.resolved ? 'resolved' : thread.outdated ? 'outdated' : 'open';
    const where = thread.anchor?.path.split('/').at(-1) ?? 'PR';
    const replies = flattenThread(thread.root).slice(1);
    // Existing replies appear automatically while writing a reply, so the reviewer can see the conversation.
    const repliesShown = repliesOpen || composer !== null;
    return (
        <article className="discussion-thread">
            <div className="discussion-thread__head">
                <span className="discussion-thread__avatar" aria-hidden="true">
                    {initials(authorName(thread.root))}
                </span>
                <span className="discussion-thread__author">{authorName(thread.root)}</span>
                <span className="discussion-card__spacer" />
                <span className={`discussion-thread__state${state === 'open' ? ' is-open' : ''}`}>
                    {t(`overview.discussion.state.${state}`)}
                </span>
                {pinned === null ? null : <ThreadPinChip pinned={pinned} />}
            </div>
            <div className={`discussion-thread__body${clamped ? ' is-clamped' : ''}`}>
                <Markdown text={thread.root.body} profile="comment" />
            </div>
            {clampable ? (
                <button
                    type="button"
                    className="ctl ctl--link discussion-thread__expand"
                    aria-expanded={expanded}
                    onClick={() => {
                        setExpanded(!expanded);
                    }}
                >
                    {expanded ? t('overview.discussion.body.collapse') : t('overview.discussion.body.expand')}
                </button>
            ) : null}
            <div className="discussion-thread__foot">
                <span className="discussion-thread__meta">
                    {t('thread.meta', where, relativeTime(thread.root.createdAt, now, locale))}
                </span>
                {replies.length === 0 ? null : (
                    <button
                        type="button"
                        className="ctl ctl--link discussion-thread__replies-toggle"
                        aria-expanded={repliesShown}
                        onClick={() => {
                            setRepliesOpen(!repliesShown);
                        }}
                    >
                        {t('thread.replies', replies.length)}
                    </button>
                )}
                <span className="discussion-card__spacer" />
                {composer === null ? (
                    <button
                        type="button"
                        className="ctl ctl--ghost ctl--compact discussion-thread__reply"
                        onClick={() => {
                            // The reply will go into this same list. Expand it now, or saving
                            // will close the composer and leave nowhere to see the new reply.
                            setRepliesOpen(true);
                            openReply(store, thread);
                        }}
                    >
                        {t('overview.discussion.reply')}
                    </button>
                ) : null}
            </div>
            {repliesShown && replies.length > 0 ? (
                <div className="discussion-thread__replies">
                    {replies.map((row) => (
                        <div key={row.comment.id} className="discussion-reply">
                            <div className="discussion-reply__head">
                                <span className="discussion-reply__author">{authorName(row.comment)}</span>
                                {row.comment.draft ? (
                                    <span className="discussion-reply__draft">{t('thread.chip.draft')}</span>
                                ) : null}
                                <span className="discussion-card__spacer" />
                                <span className="discussion-reply__meta">
                                    {relativeTime(row.comment.createdAt, now, locale)}
                                </span>
                            </div>
                            <div className="discussion-thread__body">
                                <Markdown text={row.comment.body} profile="comment" />
                            </div>
                        </div>
                    ))}
                </div>
            ) : null}
            {composer === null ? null : (
                <CommentComposer
                    composer={composer}
                    store={store}
                    transport={transport}
                    contextLabel={t('thread.reply.context', authorName(thread.root))}
                    placeholder={t('thread.reply.placeholder')}
                    inputLabel={t('thread.reply.label')}
                    closeOnSave
                />
            )}
        </article>
    );
}

function useComposerSnapshot(store: ThreadStore, key: string): ComposerSnapshot | null {
    const subscribe = useCallback((listener: () => void) => store.subscribeComposer(key, listener), [key, store]);
    const getSnapshot = useCallback(() => store.getComposer(key), [key, store]);
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function initials(name: string): string {
    return name
        .split(/[\s._-]+/u)
        .filter((part) => part !== '')
        .slice(0, 2)
        .map((part) => part[0]?.toUpperCase() ?? '')
        .join('');
}

const EMPTY_THREADS: readonly Thread[] = [];
