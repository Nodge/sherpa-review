import type { ViewId } from '../session/views.js';
import './view-frames.css';

/**
 * Frames for the three views. They have no content in M1-T4. Each names the task that
 * will provide it. The "Route" tab remains a full tab (SPEC §2.1: it is never disabled).
 */

interface Frame {
    readonly title: string;
    readonly note: string;
}

const FRAMES: Record<ViewId, Frame> = {
    overview: {
        title: 'Overview',
        note: 'The PR card with files by ownership zone, discussion and snapshots, without the AI layer, comes in M1-T15.',
    },
    route: {
        title: 'Route',
        note: 'The agent builds the route. The prompt to run the skill and the "no route yet" state come in M1-T15.',
    },
    diff: {
        title: 'Full diff',
        note: 'Diff cards come in M1-T6, the file tree and filters in M1-T7.',
    },
};

export function ViewFrame({ view }: { view: ViewId }) {
    const frame = FRAMES[view];

    return (
        <main className="view-frame" id={`view-${view}`}>
            <h1 className="view-frame__title">{frame.title}</h1>
            <p className="view-frame__note">{frame.note}</p>
        </main>
    );
}
