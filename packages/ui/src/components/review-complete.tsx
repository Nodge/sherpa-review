import type { Verdict } from '@sherpa/protocol';

import { formatCount, plural } from '../text.js';
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
                    <span className="review-complete__check" aria-hidden="true">✓</span>
                    <h1 id="review-complete-title">{verdictTitle(completion.verdict)} · PR {completion.prId}</h1>
                    <span className="review-complete__provenance">{verdictProvenance(completion.verdict, commit)}</span>
                </header>

                <div className="review-complete__delivery">
                    <span>{publishedBatchText(completion.publishedComments)}</span>
                    <span>delivered to {completion.hostName}</span>
                </div>

                <dl className="review-complete__counters">
                    <Counter
                        label="Files seen"
                        value={`${formatCount(completion.progress.filesSeen)} of ${formatCount(completion.progress.filesTotal)}`}
                    />
                    <Counter
                        label="Diff seen"
                        value={`${formatCount(completion.progress.percentSeen)}% of ${formatCount(completion.progress.linesTotal)} lines`}
                    />
                    <Counter
                        label="Comments published"
                        value={`${formatCount(completion.publishedComments)} (${formatCount(replies)} of them ${plural(replies, 'a reply', 'replies', 'replies')})`}
                    />
                    <Counter label="Snapshot signed" value={`${commit} · PR head ${commit}`} />
                </dl>

                {completion.openThreads > 0 && completion.firstOpenThreadId !== null ? (
                    <footer className="review-complete__open-threads">
                        <span>
                            {formatCount(completion.openThreads)}{' '}
                            {plural(completion.openThreads, 'thread is still open', 'threads are still open', 'threads are still open')} — that does not block the ship, you still have them on your list
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

function Counter({ label, value }: { label: string; value: string }) {
    return (
        <div className="review-complete__counter">
            <dt>{label}</dt>
            <dd>{value}</dd>
        </div>
    );
}

function shortCommit(commit: string): string {
    return commit.slice(0, 7);
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
    const comments = plural(value, 'comment', 'comments', 'comments');
    const form = plural(value, 'published', 'published', 'published');
    return `${formatCount(value)} ${comments} ${form} as one batch`;
}
