import type { Verdict } from '@sherpa/protocol';

import type { Translate } from '../i18n/index.js';
import { shortCommit, useT } from '../i18n/index.js';
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
    const t = useT();
    const commit = shortCommit(completion.headCommit);
    const replies = completion.publishedReplies;
    return (
        <main className="review-complete">
            <section className="review-complete__card" aria-labelledby="review-complete-title">
                <header className="review-complete__header">
                    <span className="review-complete__check" aria-hidden="true">
                        <Icon name="check" size={14} />
                    </span>
                    <h1 id="review-complete-title">
                        {verdictTitle(completion.verdict, t)} · PR {completion.prId}
                    </h1>
                    <span className="review-complete__provenance">
                        {verdictProvenance(completion.verdict, commit, t)}
                    </span>
                </header>

                <div className="review-complete__delivery">
                    <span>{t('complete.batch', completion.publishedComments)}</span>
                    <span>{t('complete.deliveredTo', completion.hostName)}</span>
                </div>

                <dl className="review-complete__counters">
                    {completion.route === null ? (
                        <Counter
                            label={t('complete.filesSeen')}
                            value={t(
                                'complete.filesSeen.value',
                                completion.progress.filesSeen,
                                completion.progress.filesTotal,
                            )}
                        />
                    ) : (
                        <Counter label={t('complete.stopsViewed')} value={stopsValue(completion.route, t)} />
                    )}
                    <Counter
                        label={t('complete.diffSeen')}
                        value={t(
                            'complete.diffSeen.value',
                            completion.progress.percentSeen,
                            completion.progress.linesTotal,
                        )}
                    />
                    {/*
                      "Of that, read outside the route" (docs/design/README.md §13) is part of what has already been seen, so
                      this row depends on the Other mark, which means the uncovered ranges
                      were read as raw diff. Without it, the number would describe only the route model.
                    */}
                    <ReadOutsideRoute route={completion.route} />
                    <Counter
                        label={t('complete.published')}
                        value={t('complete.published.value', completion.publishedComments, replies)}
                    />
                    <Counter label={t('complete.snapshot')} value={`${commit} · PR head ${commit}`} />
                </dl>

                {completion.openThreads > 0 && completion.firstOpenThreadId !== null ? (
                    <footer className="review-complete__open-threads">
                        <span>{t('complete.openThreads', completion.openThreads)}</span>
                        <button
                            type="button"
                            onClick={() => {
                                if (completion.firstOpenThreadId !== null) {
                                    onOpenThread(completion.firstOpenThreadId);
                                }
                            }}
                        >
                            {t('complete.openThread')}
                        </button>
                    </footer>
                ) : null}

                <div className="review-complete__actions">
                    <button type="button" onClick={onOpenFullDiff}>
                        {t('route.toFullDiff')}
                    </button>
                </div>
            </section>
        </main>
    );
}

/** "7 of 7 · Other read as raw diff" (docs/design/README.md §13): the second clause appears only when true. */
function stopsValue(route: NonNullable<ReviewCompletion['route']>, t: Translate): string {
    const counted = t('complete.stopsViewed.value', route.stopsViewed, route.stopsTotal);
    return route.otherViewed ? t('complete.stopsViewed.other', counted) : counted;
}

/** The "Of that, read outside the route" row appears only when Other is actually marked. */
function ReadOutsideRoute({ route }: { route: ReviewCompletion['route'] }) {
    const t = useT();
    const lines = route?.otherViewed === true ? (route.uncoveredLines ?? 0) : 0;
    if (lines === 0) {
        return null;
    }
    return <Counter label={t('complete.outsideRoute')} value={t('complete.outsideRoute.value', lines)} />;
}

function Counter({ label, value }: { label: string; value: string }) {
    return (
        <div className="review-complete__counter">
            <dt>{label}</dt>
            <dd>{value}</dd>
        </div>
    );
}


function verdictTitle(verdict: Verdict, t: Translate): string {
    if (verdict === 'sticky_ship') {
        return t('ship.mode.sticky');
    }
    return t(verdict === 'request_changes' ? 'complete.verdict.requestChanges' : 'complete.verdict.shipped');
}

function verdictProvenance(verdict: Verdict, commit: string, t: Translate): string {
    if (verdict === 'sticky_ship') {
        return t('complete.sticky', commit);
    }
    return verdict === 'request_changes' ? `request changes · ${commit}` : `ship · ${commit}`;
}
