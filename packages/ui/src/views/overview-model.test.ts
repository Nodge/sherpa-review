import { fixtureData } from '@sherpa/fixtures';
import type { FileDiff, Lens, Thread } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import { discussionStats, ownershipSummary } from './overview-model.js';

const DATA = fixtureData('medium');
const BASE = requiredFile();

function file(
    fileId: string,
    path: string,
    additions: number,
    deletions: number,
    generated = false,
): FileDiff {
    return { ...BASE, fileId, path, additions, deletions, generated };
}

const FILES = [
    file('mine', 'services/orders/a.ts', 4, 1),
    file('other-same-root', 'services/orders/b.ts', 2, 2),
    file('other', 'infra/ci/config.ts', 3, 0),
    file('generated', 'pnpm-lock.yaml', 10, 5, true),
];
const OWNERSHIP: Lens = {
    id: 'mine',
    label: 'My files',
    paths: ['services/orders/a.ts'],
    available: true,
    note: null,
};

describe('Overview: files by ownership', () => {
    it('calculates the header, deltas and directory chips for the "All" segment', () => {
        const summary = ownershipSummary(FILES, OWNERSHIP, 'all');

        expect(summary).toMatchObject({
            available: true,
            mineFiles: 1,
            totalFiles: 4,
            mineLines: 5,
            totalLines: 27,
        });
        expect(summary.groups).toEqual([
            {
                path: 'services/orders',
                files: 2,
                lines: 9,
                additions: 6,
                deletions: 3,
                ownership: 'mixed',
            },
            {
                path: 'infra/ci',
                files: 1,
                lines: 3,
                additions: 3,
                deletions: 0,
                ownership: 'other',
            },
            {
                path: 'pnpm-lock.yaml',
                files: 1,
                lines: 15,
                additions: 10,
                deletions: 5,
                ownership: 'generated',
            },
        ]);
    });

    it('the "My zone" segment aggregates only lens files', () => {
        expect(ownershipSummary(FILES, OWNERSHIP, 'mine').groups).toEqual([
            {
                path: 'services/orders',
                files: 1,
                lines: 5,
                additions: 4,
                deletions: 1,
                ownership: 'mine',
            },
        ]);
    });

    it('shows the reason and removes ownership chips when the lens is unavailable', () => {
        const summary = ownershipSummary(
            FILES,
            { ...OWNERSHIP, available: false, paths: [], note: 'no CODEOWNERS zone' },
            'mine',
        );

        expect(summary.available).toBe(false);
        expect(summary.note).toBe('no CODEOWNERS zone');
        expect(summary.groups).toHaveLength(3);
        expect(summary.groups.every((group) => group.ownership === null)).toBe(true);
    });
});

describe('Overview: discussion counters', () => {
    it('counts open, resolved and bot threads using the same Thread models', () => {
        const person = requiredThread((thread) => !thread.resolved && !thread.root.author.bot);
        const bot = requiredThread((thread) => !thread.resolved && thread.root.author.bot);
        const resolvedBot: Thread = { ...bot, id: 'resolved-bot', resolved: true };

        expect(discussionStats([person, bot, resolvedBot])).toEqual({ open: 2, resolved: 1, bots: 2 });
    });
});

function requiredFile(): FileDiff {
    const file = DATA.diff.files[0];
    if (file === undefined) {
        throw new Error('medium fixture has no files');
    }
    return file;
}

function requiredThread(predicate: (thread: Thread) => boolean): Thread {
    const thread = DATA.threads.find(predicate);
    if (thread === undefined) {
        throw new Error('medium fixture lacks required thread');
    }
    return thread;
}
