import type { Verdict } from '@sherpa/protocol';

import { formatCount, plural, shortCommit } from '../i18n/index.js';
import { Icon } from '../icons/icon.tsx';
import type { ReviewCompletion } from './review-action-bar.tsx';
import './review-complete.css';

export interface ReviewCompleteProps {
    readonly completion: ReviewCompletion;
    readonly onOpenThread: (threadId: string) => void;
    readonly onOpenFullDiff: () => void;
}

/** Session-scoped publishing summary, not persisted, cleared on the next navigation. */
export function ReviewComplete({ completion, onOpenThread, onOpenFullDiff }: ReviewCompleteProps) {
    const commit = shortCommit(completion.headCommit);
    const replies = completion.publishedReplies;
    return (
        <main className="review-complete">
            <section className="review-complete__card" aria-labelledby="review-complete-title">
                <header className="review-complete__header">
                    <span className="review-complete__check" aria-hidden="true">
                        <Icon name="check" size={14} />
                    </span>
                    <h1 id="review-complete-title">{verdictTitle(completion.verdict)} · PR {completion.prId}</h1>
                    <span className="review-complete__provenance">{verdictProvenance(completion.verdict, commit)}</span>
                </header>

                <div className="review-complete__delivery">
                    <span>{publishedBatchText(completion.publishedComments)}</span>
                    <span>delivered to {completion.hostName}</span>
                </div>

                <dl className="review-complete__counters">
                    {completion.route === null ? (
                        <Counter
                            label="Files seen"
                            value={`${formatCount(completion.progress.filesSeen, 'ru')} of ${formatCount(completion.progress.filesTotal, 'ru')}`}
                        />
                    ) : (
                        <Counter label="Stops viewed" value={stopsValue(completion.route)} />
                    )}
                    <Counter
                        label="Diff seen"
                        value={`${formatCount(completion.progress.percentSeen, 'ru')}% of ${formatCount(completion.progress.linesTotal, 'ru')} lines`}
                    />
                    {/*
                      "Of that, read outside the route" (README §13) is part of what was already seen, so
                      this row depends on the Other mark, which means the uncovered ranges
                      were read as raw diff. Without it, the number would describe only the route model.
                    */}
                    {readOutsideRoute(completion.route)}
                    <Counter
                        label="Comments published"
                        value={`${formatCount(completion.publishedComments, 'ru')} (including ${formatCount(replies, 'ru')} ${plural(replies, { one: 'reply', few: 'replies', many: 'replies', other: 'replies' }, 'ru')})`}
                    />
                    <Counter label="Snapshot signed" value={`${commit} · PR head ${commit}`} />
                </dl>

                {completion.openThreads > 0 && completion.firstOpenThreadId !== null ? (
                    <footer className="review-complete__open-threads">
                        <span>
                            {formatCount(completion.openThreads, 'ru')}{' '}
                            {plural(completion.openThreads, { one: 'thread is still open', few: 'threads are still open', many: 'threads are still open', other: 'threads are still open' }, 'ru')}. This does not block ship. Open threads remain on your list
                        </span>
                        <button
                            type="button"
                            onClick={() => {
                                if (completion.firstOpenThreadId !== null) {
                                    onOpenThread(completion.firstOpenThreadId);
                                }
                            }}
                        >
                            Open the thread
                        </button>
                    </footer>
                ) : null}

                <div className="review-complete__actions">
                    <button type="button" onClick={onOpenFullDiff}>To the full diff</button>
                </div>
            </section>
        </main>
    );
}

/** "7 of 7 · Other read as a raw diff" (README §13): the second clause appears only when true. */
function stopsValue(route: NonNullable<ReviewCompletion['route']>): string {
    const counted = `${formatCount(route.stopsViewed, 'ru')} of ${formatCount(route.stopsTotal, 'ru')}`;
    return route.otherViewed ? `${counted} · Other read as a raw diff` : counted;
}

/** The "Of that, read outside the route" row appears only when Other is actually marked. */
function readOutsideRoute(route: ReviewCompletion['route']) {
    const lines = route?.otherViewed === true ? (route.uncoveredLines ?? 0) : 0;
    if (lines === 0) {
        return null;
    }
    return (
        <Counter
            label="Of it read outside the route"
            value={`${formatCount(lines, 'ru')} ${plural(lines, { one: 'line', few: 'lines', many: 'lines', other: 'lines' }, 'ru')}, which the model did not place`}
        />
    );
}

function Counter({ label, value }: { label: string; value: string }) {
    return (
        <div className="review-complete__counter">
            <dt>{label}</dt>
            <dd>{value}</dd>
        </div>
    );
}


function verdictTitle(verdict: Verdict): string {
    if (verdict === 'sticky_ship') {
        return 'Sticky ship';
    }
    return verdict === 'request_changes' ? 'Changes requested' : 'Shipped';
}

function verdictProvenance(verdict: Verdict, commit: string): string {
    if (verdict === 'sticky_ship') {
        return `sticky ship · carries over to later pushes · ${commit}`;
    }
    return verdict === 'request_changes' ? `request changes · ${commit}` : `ship · ${commit}`;
}

function publishedBatchText(value: number): string {
    const comments = plural(value, { one: 'comment', few: 'comments', many: 'comments', other: 'comments' }, 'ru');
    const form = plural(value, { one: 'published', few: 'published', many: 'published', other: 'published' }, 'ru');
    return `${formatCount(value, 'ru')} ${comments} ${form} in one batch`;
}
