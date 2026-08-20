import type { Comment, FileDiff } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import { buildFixture, FIXTURE_NAMES, fixtureData, LARGE_FILE_COUNT, MEDIUM_TOTALS } from './data/index.js';
import { totalChanges } from './patch.js';

const HUNK_HEADER = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@(?: .*)?$/;

interface HunkCounts {
    additions: number;
    deletions: number;
}

/**
 * Minimal unified diff parsing: hunk headers, matching counts and consistent line
 * numbers between hunks of one file (`newStart − oldStart` must equal the accumulated
 * delta of previous hunks, with hunks ordered and non-overlapping, otherwise `git apply` will reject
 * the patch, and context expansion and the minimap in the UI will break). The full parser is M1-T5.
 * Here, fixtures must be parseable and report accurate `+N/−M` counts.
 */
function parsePatch(patch: string): HunkCounts {
    const lines = patch.split('\n');
    if (lines.at(-1) === '') {
        lines.pop();
    }

    let seenHunk = false;
    let additions = 0;
    let deletions = 0;
    let expectedOld = 0;
    let expectedNew = 0;
    let actualOld = 0;
    let actualNew = 0;
    // Accumulated line delta of the hunks seen so far and their right boundaries.
    let delta = 0;
    let prevOldEnd = 0;
    let prevNewEnd = 0;

    for (const line of lines) {
        const header = HUNK_HEADER.exec(line);
        if (header !== null) {
            const oldStart = Number(header[1]);
            const newStart = Number(header[3]);
            if (seenHunk) {
                expect(actualOld).toBe(expectedOld);
                expect(actualNew).toBe(expectedNew);
                delta += expectedNew - expectedOld;
                expect({ header: line, newStart }).toEqual({ header: line, newStart: oldStart + delta });
                expect(oldStart).toBeGreaterThan(prevOldEnd);
                expect(newStart).toBeGreaterThan(prevNewEnd);
            }
            seenHunk = true;
            expectedOld = Number(header[2]);
            expectedNew = Number(header[4]);
            prevOldEnd = oldStart + expectedOld - 1;
            prevNewEnd = newStart + expectedNew - 1;
            actualOld = 0;
            actualNew = 0;
            continue;
        }

        if (!seenHunk) {
            // File header: `diff --git`, modes, `index`, `---`/`+++`.
            expect(line).toMatch(
                /^(diff --git |index |--- |\+\+\+ |new file mode |deleted file mode |old mode |new mode |rename |copy |similarity index )/,
            );
            continue;
        }

        const prefix = line.slice(0, 1);
        if (prefix === '+') {
            additions += 1;
            actualNew += 1;
        } else if (prefix === '-') {
            deletions += 1;
            actualOld += 1;
        } else if (prefix === ' ') {
            actualOld += 1;
            actualNew += 1;
        } else {
            throw new Error(`line outside a hunk with no prefix: ${JSON.stringify(line)}`);
        }
    }

    if (seenHunk) {
        expect(actualOld).toBe(expectedOld);
        expect(actualNew).toBe(expectedNew);
    } else {
        // A patch without hunks is valid only for a file mode change.
        expect(lines.some((line) => line.startsWith('new mode '))).toBe(true);
    }

    return { additions, deletions };
}

function depthOf(comment: Comment): number {
    return comment.replies.reduce((max, reply) => Math.max(max, depthOf(reply) + 1), 1);
}

function hasBranching(comment: Comment): boolean {
    return comment.replies.length > 1 || comment.replies.some(hasBranching);
}

function countDrafts(comment: Comment): number {
    return comment.replies.reduce((total, reply) => total + countDrafts(reply), comment.draft ? 1 : 0);
}

function fileByPath(files: readonly FileDiff[], path: string): FileDiff {
    const file = files.find((candidate) => candidate.path === path);
    if (file === undefined) {
        throw new Error(`fixture has no file ${path}`);
    }
    return file;
}

describe('fixtures: shared invariants', () => {
    for (const name of FIXTURE_NAMES) {
        describe(name, () => {
            it('is deterministic: rebuilding produces the same data', () => {
                // Two builds from scratch: comparing two accesses to the `fixtureData` cache would pass
                // even with `Date.now()` inside the builder.
                expect(JSON.stringify(buildFixture(name))).toBe(JSON.stringify(buildFixture(name)));
            });

            it('has valid unified diff patches with matching counts', () => {
                const { files } = fixtureData(name).diff;
                for (const file of files) {
                    if (file.patch === null) {
                        expect(file.binary || file.additions + file.deletions === 0).toBe(true);
                        continue;
                    }
                    const counts = parsePatch(file.patch);
                    expect(counts).toEqual({ additions: file.additions, deletions: file.deletions });
                }
            });

            it('anchors threads to files in this diff', () => {
                const data = fixtureData(name);
                const byId = new Map(data.diff.files.map((file) => [file.fileId, file] as const));
                for (const thread of data.threads) {
                    if (thread.anchor === null) {
                        continue;
                    }
                    expect(byId.get(thread.anchor.fileId)?.path).toBe(thread.anchor.path);
                }
            });

            it('has no drafts in the source data', () => {
                const drafts = fixtureData(name).threads.reduce(
                    (total, thread) => total + countDrafts(thread.root),
                    0,
                );
                expect(drafts).toBe(0);
            });
        });
    }
});

describe('medium fixture', () => {
    const data = fixtureData('medium');

    it('matches the handoff header: 18 files, +806 −56', () => {
        expect(data.diff.files.length).toBe(MEDIUM_TOTALS.files);
        expect(totalChanges(data.diff.files)).toEqual({
            additions: MEDIUM_TOTALS.additions,
            deletions: MEDIUM_TOTALS.deletions,
        });
    });

    it('has a deep branching thread (observed host maximum is 14)', () => {
        const deepest = data.threads.reduce((max, thread) => Math.max(max, depthOf(thread.root)), 0);
        expect(deepest).toBeGreaterThan(6);
        expect(data.threads.some((thread) => hasBranching(thread.root))).toBe(true);
    });

    it('includes every thread kind: human, bot, resolved, outdated and PR-level', () => {
        expect(data.threads.filter((thread) => !thread.root.author.bot).length).toBeGreaterThanOrEqual(4);
        const bots = data.threads.filter((thread) => thread.root.author.bot);
        expect(bots.length).toBe(2);
        for (const thread of bots) {
            expect(thread.root.author.displayName).toMatch(/^AI Review \(/);
        }
        expect(data.threads.filter((thread) => thread.resolved).length).toBe(1);
        expect(data.threads.filter((thread) => thread.outdated).length).toBe(1);
        expect(data.threads.filter((thread) => thread.anchor === null).length).toBe(1);
    });

    it('comment ids follow the host sign convention', () => {
        for (const thread of data.threads) {
            const inline = thread.anchor !== null;
            expect(Number(thread.root.id) > 0).toBe(inline);
        }
    });

    it('includes generated files that overlap with the PCI lens', () => {
        const generated = data.diff.files.filter((file) => file.generated).map((file) => file.path);
        expect(generated.length).toBeGreaterThanOrEqual(2);

        const pci = data.extraLenses.find((lens) => lens.id === 'pci');
        expect(pci?.paths.length).toBeGreaterThanOrEqual(2);
        expect(pci?.paths.some((path) => generated.includes(path))).toBe(true);
    });

    it('covers some files with the ownership lens, but not all', () => {
        const paths = data.ownership?.paths ?? [];
        expect(paths.length).toBeGreaterThan(0);
        expect(paths.length).toBeLessThan(data.diff.files.length);
        for (const path of paths) {
            expect(data.diff.files.some((file) => file.path === path)).toBe(true);
        }
    });
});

describe('small fixture', () => {
    const data = fixtureData('small');

    it('is below the route threshold (requirements §3.6)', () => {
        expect(data.diff.files.length).toBeLessThanOrEqual(1);
        const totals = totalChanges(data.diff.files);
        expect(totals.additions + totals.deletions).toBeLessThanOrEqual(40);
    });

    it('returns viewed: null for a host without viewed sync', () => {
        expect(data.pr.capabilities.fileViewedSync).toBe(false);
        for (const file of data.diff.files) {
            expect(file.viewed).toBeNull();
        }
    });
});

describe('large fixture', () => {
    const data = fixtureData('large');

    it('supports virtualization tests: 60+ files and thousands of lines', () => {
        expect(data.diff.files.length).toBe(LARGE_FILE_COUNT);
        expect(data.diff.files.length).toBeGreaterThanOrEqual(60);
        const totals = totalChanges(data.diff.files);
        expect(totals.additions + totals.deletions).toBeGreaterThan(2000);
    });
});

describe('edge fixture', () => {
    const data = fixtureData('edge');
    const files = data.diff.files;

    it('includes the previous path for a rename', () => {
        const moved = fileByPath(files, 'services/orders/src/infra/time/clock.ts');
        expect(moved.changeType).toBe('move');
        expect(moved.oldPath).toBe('services/orders/src/infra/clock.ts');
        expect(moved.patch).toContain('rename from services/orders/src/infra/clock.ts');
    });

    it('has only deletions for a deleted file', () => {
        const deleted = fileByPath(files, 'services/orders/src/legacy/edit-window-v1.ts');
        expect(deleted.changeType).toBe('delete');
        expect(deleted.additions).toBe(0);
        expect(deleted.deletions).toBeGreaterThan(0);
    });

    it('returns binary files without a patch', () => {
        const binary = fileByPath(files, 'services/orders/assets/edit-window-flow.png');
        expect(binary.binary).toBe(true);
        expect(binary.patch).toBeNull();
    });

    it('has no patch or changed lines for an empty file', () => {
        const empty = fileByPath(files, 'services/orders/src/infra/time/index.ts');
        expect(empty.patch).toBeNull();
        expect(empty.additions + empty.deletions).toBe(0);
    });

    it('changes only whitespace in a whitespace-only diff', () => {
        const file = fileByPath(files, 'services/orders/src/api/schemas.ts');
        const patch = file.patch ?? '';
        const added = patch
            .split('\n')
            .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
            .map((line) => line.slice(1).trim());
        const removed = patch
            .split('\n')
            .filter((line) => line.startsWith('-') && !line.startsWith('---'))
            .map((line) => line.slice(1).trim());
        expect(added).toEqual(removed);
    });

    it('has only additions for a one-sided file', () => {
        const oneSided = fileByPath(files, 'services/orders/docs/rollout.md');
        expect(oneSided.deletions).toBe(0);
        expect(oneSided.additions).toBeGreaterThan(0);
    });

    it('has old/new mode headers with no hunks or changed lines for a mode change', () => {
        const script = fileByPath(files, 'services/orders/scripts/rollout.sh');
        const patch = script.patch ?? '';
        expect(patch).toContain('old mode 100644');
        expect(patch).toContain('new mode 100755');
        expect(patch).not.toContain('@@');
        expect(script.additions + script.deletions).toBe(0);
    });

    it('marks a conflicting file with its own change type', () => {
        expect(fileByPath(files, 'services/orders/src/domain/order.ts').changeType).toBe('conflict');
    });
});
