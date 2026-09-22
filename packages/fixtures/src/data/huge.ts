import type { FileDiff, LensZone, Thread } from '@sherpa/protocol';

import { anchor, comment, human, lens, singleIteration, thread } from '../builders.js';
import type { SyntheticFile, SyntheticParams } from './synthetic.js';
import { modulePathOf, synthesizeFiles } from './synthetic.js';
import type { FixtureDataInput } from './types.js';

/**
 * Performance fixture (`docs/testing.md §5`): 100 files and over 20 000 changed lines, the size used
 * to measure time to first frame, worker parsing, and scroll frame time. In a normal review, such a
 * PR would not be read. It provides a size limit here, rather than a realistic reading scenario.
 *
 * The size distribution resembles a large PR: dozens of small edits, a couple of dozen medium ones,
 * a few large ones, and exactly one file above the collapse threshold (`docs/design/SPEC-elements.md §2.13`).
 */

const PR_ID = '5486';
export const HUGE_DIFF_ID = '206420';
const UPDATED_AT = '2026-08-27T09:15:00.000Z';
const MODULES = 20;
const FILES_PER_MODULE = 5;
export const HUGE_FILE_COUNT = MODULES * FILES_PER_MODULE;
/** Total PR size: additions + deletions across all files. */
export const HUGE_CHANGED_LINE_COUNT = 25_274;

const ROOT = 'services/orders/src/platform';
const FILE_KINDS = ['service.ts', 'repository.ts', 'mapper.ts', 'handlers.ts', 'index.test.ts'] as const;

/**
 * Load that actually reaches the worker and line rendering: cards collapsed for a reason
 * (`viewed`: 14 files, `generated`: 10) do not request parsing (`diff-view/file-list.tsx`).
 * Of the 100 files and 25 274 changed lines in the fixture, these 76 files and 21 260 lines are measured.
 * The performance run and its report use these counts, rather than the total PR size.
 */
export const HUGE_PARSED_FILE_COUNT = 76;
export const HUGE_PARSED_LINE_COUNT = 21_260;

/** The only file above the collapse threshold: its card opens collapsed. */
const COLLAPSED_FILE_INDEX = 0;
export const HUGE_COLLAPSED_FILE_LINES = 2412;
export const HUGE_COLLAPSED_FILE_PATH = `${modulePathOf(ROOT, 0)}/${FILE_KINDS[0]}`;

/** Files with long lines. All four are modifications with far fewer deletions than additions. */
const LONG_LINE_INDEXES = new Set([4, 27, 58, 91]);

type SizeClass = 'collapsed' | 'large' | 'medium' | 'small';

function sizeClassAt(index: number): SizeClass {
    if (index === COLLAPSED_FILE_INDEX) {
        return 'collapsed';
    }
    if (index % 24 === 5) {
        return 'large';
    }
    return index % 3 === 2 ? 'medium' : 'small';
}

const PARAMS: SyntheticParams = {
    diffId: HUGE_DIFF_ID,
    root: ROOT,
    modules: MODULES,
    filesPerModule: FILES_PER_MODULE,
    fileKinds: FILE_KINDS,
    // Every tenth file is generated, roughly the same share as in a large PR with code generation.
    generatedAt: (index) => index % 10 === 9,
    changeTypeAt: (index) => {
        if (index === COLLAPSED_FILE_INDEX) {
            return 'add';
        }
        if (index % 20 === 3) {
            return 'delete';
        }
        return index % 7 === 1 ? 'add' : 'modify';
    },
    sizeAt: (index) => {
        switch (sizeClassAt(index)) {
            case 'collapsed':
                return { additions: HUGE_COLLAPSED_FILE_LINES, deletions: 0, hunks: 1 };
            case 'large':
                return { additions: 700 + (index % 3) * 90, deletions: 240 + (index % 5) * 30, hunks: 5 + (index % 2) };
            case 'medium':
                return { additions: 250 + (index % 11) * 14, deletions: 80 + (index % 7) * 12, hunks: 3 + (index % 3) };
            case 'small':
                return { additions: 44 + (index % 13) * 6, deletions: 14 + (index % 9) * 5, hunks: 2 + (index % 2) };
        }
    },
    context: 3,
    viewedAt: (index, changeType) => changeType === 'modify' && index % 6 === 0,
    longLinesAt: (index) => LONG_LINE_INDEXES.has(index),
    sectionAt: (moduleIndex) => `export class Platform${String(moduleIndex + 1)}`,
};

/**
 * Fixture files with a map of changed ranges. The route fixture uses it to build
 * anchors, so they cover only changed lines by construction.
 */
export function hugeFiles(): SyntheticFile[] {
    return synthesizeFiles(PARAMS);
}

/** Line inside a changed file range, used as a thread anchor. */
function changedLine(entry: SyntheticFile): { path: string; side: 'old' | 'new'; line: number } {
    const range = entry.ranges.find((candidate) => candidate.side === 'new') ?? entry.ranges[0];
    if (range === undefined) {
        throw new Error(`file ${entry.file.path} has no changed lines`);
    }
    return { path: entry.file.path, side: range.side, line: range.start };
}

function threads(files: readonly SyntheticFile[]): Thread[] {
    const reviewer = human('alice', 'Alice Ingram');
    const author = human('eli', 'Eli Kramer');
    const at = (index: number): { path: string; side: 'old' | 'new'; line: number } => {
        const entry = files[index];
        if (entry === undefined) {
            throw new Error(`huge fixture has no file at index ${String(index)}`);
        }
        return changedLine(entry);
    };

    const spots = [at(2), at(17), at(41), at(76)];
    const bodies = [
        'This split leaves two callers reading the old adapter — worth a follow-up.',
        'The mapper duplicates the platform-wide converter; can it delegate instead?',
        'Deleting this handler drops the only retry path for the legacy queue.',
        'Generated output landed next to hand-written code again.',
    ];

    const inline = spots.map((spot, position) =>
        thread({
            id: `5320${String(100 + position)}`,
            anchor: anchor(HUGE_DIFF_ID, spot.path, { side: spot.side, line: spot.line }),
            resolved: position === 1,
            ...(position === 1 ? { resolvedBy: author.login } : {}),
            root: comment({
                id: `5320${String(100 + position)}`,
                author: reviewer,
                body: bodies[position] ?? '',
                createdAt: `2026-08-27T08:${String(10 + position).padStart(2, '0')}:00.000Z`,
            }),
        }),
    );

    return [
        ...inline,
        thread({
            anchor: null,
            root: comment({
                id: '-42117',
                author: reviewer,
                body: 'A hundred files in one push is past what a single review pass can hold — please cut it into module-sized PRs.',
                createdAt: '2026-08-27T09:15:00.000Z',
            }),
        }),
    ];
}

export function makeHugeFixture(): FixtureDataInput {
    const synthesized = hugeFiles();
    const files: FileDiff[] = synthesized.map((entry) => entry.file);

    const reviewer = human('alice', 'Alice Ingram');
    const zones: LensZone[] = Array.from({ length: MODULES }, (_, moduleIndex) => {
        const path = modulePathOf(ROOT, moduleIndex);
        const mine = moduleIndex % 3 === 0;
        return {
            path,
            mine,
            owner: mine ? 'checkout-platform' : 'checkout-runtime',
            paths: files.filter((file) => !file.generated && file.path.startsWith(`${path}/`)).map((file) => file.path),
        };
    });
    const minePaths = zones.filter((zone) => zone.mine).flatMap((zone) => zone.paths);

    return {
        pr: {
            id: PR_ID,
            url: `https://github.com/quillmart/quillmart/pull/${PR_ID}`,
            title: 'Extract the checkout platform layer out of the module tree',
            author: human('eli', 'Eli Kramer'),
            fromBranch: 'eli/platform-extraction',
            toBranch: 'main',
            state: 'open',
            statusLabel: 'review_in_progress',
            checks: 'pending',
            updatedAt: UPDATED_AT,
            capabilities: { stickyShip: true, fileViewedSync: true, fileContent: true, commentIssues: true, commentResolve: true, editPublished: true, iterations: false, blobs: false },
            verdicts: [],
        },
        iterations: singleIteration(
            {
                diffId: HUGE_DIFF_ID,
                baseCommit: '3d90f1c72a48b6e05fd1937c4ab26e8901df5a37',
                headCommit: 'c47a0b6e29d5138fa0e73b415cd8206497fe1b3a',
                files,
            },
            threads(synthesized),
            UPDATED_AT,
        ),
        interdiffs: [],
        ownership: lens({
            id: 'mine',
            label: 'My files',
            paths: minePaths,
            zones,
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
        mutationEpoch: '2026-08-28T07:30:00.000Z',
    };
}
