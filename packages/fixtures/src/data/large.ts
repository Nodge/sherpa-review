import type { FileDiff } from '@sherpa/protocol';

import { anchor, comment, human, lens, thread } from '../builders.js';
import { tsLines } from '../content.js';
import { makeFileDiff } from '../patch.js';
import type { FixtureData } from './types.js';

/**
 * Large PR for virtualization (SPEC §8 item 8: 60+ files at 60fps) and performance runs (requirements §7).
 * Content is computed from the file index, without storing megabytes in the repository,
 * and the result is byte-for-byte identical across runs.
 */

const PR_ID = '5310';
const DIFF_ID = '201877';
const MODULES = 16;
const FILES_PER_MODULE = 4;
export const LARGE_FILE_COUNT = MODULES * FILES_PER_MODULE;

const FILE_KINDS = ['service.ts', 'repository.ts', 'mapper.ts', 'index.test.ts'] as const;

function modulePath(moduleIndex: number): string {
    return `services/orders/src/modules/mod-${String(moduleIndex + 1).padStart(2, '0')}`;
}

/** Every eighth file is generated, so generated folding has data to test. */
function isGenerated(index: number): boolean {
    return index % 8 === 7;
}

function fileAt(index: number): FileDiff {
    const moduleIndex = Math.floor(index / FILES_PER_MODULE);
    const kind = FILE_KINDS[index % FILES_PER_MODULE] ?? 'service.ts';
    const generated = isGenerated(index);
    const path = generated
        ? `${modulePath(moduleIndex)}/generated/${kind}`
        : `${modulePath(moduleIndex)}/${kind}`;

    // The first file in each module is new, the others are modified, giving a mix of add/modify.
    const changeType = index % FILES_PER_MODULE === 0 ? 'add' : 'modify';
    const additions = 24 + (index % 17);
    const deletions = changeType === 'add' ? 0 : 4 + (index % 9);
    const context = 3;

    if (changeType === 'add') {
        return makeFileDiff(DIFF_ID, {
            path,
            changeType,
            generated,
            hunks: [{ oldStart: 0, newStart: 1, lines: tsLines('+', additions, index) }],
        });
    }

    return makeFileDiff(DIFF_ID, {
        path,
        changeType,
        generated,
        viewed: index % 5 === 0,
        hunks: [
            {
                oldStart: 12,
                newStart: 12,
                section: `export class Module${String(moduleIndex + 1)}`,
                lines: [
                    ...tsLines(' ', context, index + 1),
                    ...tsLines('-', deletions, index + 5),
                    ...tsLines('+', additions, index + 11),
                ],
            },
        ],
    });
}

function threads(): FixtureData['threads'] {
    const reviewer = human('alice', 'Alice Ingram');
    const author = human('victor', 'Victor Tran');

    return [
        thread({
            anchor: anchor(DIFF_ID, `${modulePath(0)}/service.ts`, { side: 'new', line: 7 }),
            root: comment({
                id: '5300140',
                author: reviewer,
                body: 'Sixty-four files of the same refactoring — could the mechanical part have been a codemod?',
                createdAt: '2026-08-19T10:00:00.000Z',
                replies: [
                    comment({
                        id: '5300158',
                        author,
                        body: 'It was; the codemod output is everything except the four `mapper.ts` files.',
                        createdAt: '2026-08-19T10:22:00.000Z',
                    }),
                ],
            }),
        }),
        thread({
            anchor: anchor(DIFF_ID, `${modulePath(9)}/repository.ts`, { side: 'new', line: 15 }),
            resolved: true,
            resolvedBy: author.login,
            root: comment({
                id: '5300171',
                author: reviewer,
                body: 'This module still returns the old DTO shape.',
                createdAt: '2026-08-19T10:40:00.000Z',
            }),
        }),
        thread({
            anchor: null,
            root: comment({
                id: '-41903',
                author: reviewer,
                body: 'Please split the generated files into a separate PR next time — they double the review surface.',
                createdAt: '2026-08-19T11:02:00.000Z',
            }),
        }),
    ];
}

export function makeLargeFixture(): FixtureData {
    const files: FileDiff[] = [];
    for (let index = 0; index < LARGE_FILE_COUNT; index += 1) {
        files.push(fileAt(index));
    }

    const reviewer = human('alice', 'Alice Ingram');

    return {
        pr: {
            id: PR_ID,
            url: `https://github.com/quillmart/quillmart/pull/${PR_ID}`,
            title: 'Migrate checkout modules to the new repository interface',
            author: human('victor', 'Victor Tran'),
            fromBranch: 'victor/repository-migration',
            toBranch: 'main',
            state: 'open',
            statusLabel: 'review_in_progress',
            checks: 'failed',
            updatedAt: '2026-08-19T11:02:00.000Z',
            capabilities: { stickyShip: true, fileViewedSync: true, fileContent: true },
        },
        diff: {
            diffId: DIFF_ID,
            baseCommit: '77a1c4e8b0d3529f6e1a8c4b2d70f3915ae6c8d4',
            headCommit: 'e51b3d7092c4a6f8b1d05e37c9a24608bd173902',
            files,
        },
        threads: threads(),
        ownership: lens({
            id: 'mine',
            label: 'My files',
            paths: files.filter((_, index) => index % 3 === 0).map((file) => file.path),
        }),
        extraLenses: [
            lens({
                id: 'pci',
                label: 'PCI DSS',
                available: false,
                note: 'No files of this PR are in the PCI DSS scope.',
            }),
        ],
        currentUser: reviewer,
        mutationEpoch: '2026-08-20T09:00:00.000Z',
    };
}
