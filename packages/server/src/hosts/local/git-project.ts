import fs from 'node:fs';
import path from 'node:path';

import type { CommentDraft, PrDiff } from '@sherpa/protocol';

import type { GitFixture } from './git-fixture.js';
import { copyGitRepo, makeFeatureRepo } from './git-fixture.js';
import { gitVcs } from './git-vcs.js';
import { memoryIterationsStore } from './iterations-store.js';
import type { LocalHostOptions } from './local-host.js';
import { LocalHost } from './local-host.js';
import { memoryThreadsStore } from './threads-store.js';
import type { CommandRunner } from './vcs.js';
import { commandRunnerIn } from './vcs.js';

/**
 * Local review project using real `git` for host tests: a repository copy on `feature`,
 * with its `app` subdirectory as the project directory so unrelated repository changes can sit alongside it.
 */

export const PROJECT_PREFIX = 'app';
export const GIT_PR_KEY = 'local-git-app-0badc0de';

/** Creates an empty repository on `feature` once per test file. Each project gets a copy. */
let template: GitFixture | null = null;

export class GitProject {
    readonly repo: GitFixture;
    /** Absolute project directory path. */
    readonly dir: string;

    constructor(prefix = 'sherpa-git-project-') {
        template ??= makeFeatureRepo('sherpa-git-project-template-');
        this.repo = copyGitRepo(template, prefix);
        this.dir = path.join(this.repo.root, PROJECT_PREFIX);
        // The project directory is the cwd for `git` commands, so it must exist before the first file.
        fs.mkdirSync(this.dir, { recursive: true });
    }

    /** Real `git` in the project directory, as invoked by `localGitHostPlugin`. */
    runner(): CommandRunner {
        return commandRunnerIn('git', this.dir);
    }

    /** Host without a polling timer: `refresh` and endpoints advance the snapshot. */
    makeHost(overrides: Partial<LocalHostOptions> = {}): LocalHost {
        return new LocalHost({
            prKey: GIT_PR_KEY,
            vcs: gitVcs(this.runner()),
            projectDir: this.dir,
            base: null,
            branch: 'feature',
            threads: memoryThreadsStore(),
            iterations: memoryIterationsStore(),
            pollIntervalMs: 600_000,
            ...overrides,
        });
    }

    /** One changed file, `src/a.ts`. */
    seedOneFile(): void {
        this.repo.commitBase({ [`${PROJECT_PREFIX}/src/a.ts`]: 'const a = 1;\n' });
        this.repo.write(`${PROJECT_PREFIX}/src/a.ts`, 'const a = 2;\n');
    }

    /** Two changed files: `src/a.ts` holds a thread, `src/b.ts` is edited to advance the iteration. */
    seedTwoFiles(): void {
        this.repo.commitBase({
            [`${PROJECT_PREFIX}/src/a.ts`]: 'const a = 1;\n',
            [`${PROJECT_PREFIX}/src/b.ts`]: 'const b = 1;\n',
        });
        this.repo.write(`${PROJECT_PREFIX}/src/a.ts`, 'const a = 2;\n');
        this.repo.write(`${PROJECT_PREFIX}/src/b.ts`, 'const b = 2;\n');
    }

    cleanup(): void {
        this.repo.cleanup();
    }
}

export function fileIdOf(diff: PrDiff, filePath: string): string {
    return diff.files.find((file) => file.path === filePath)?.fileId ?? '';
}

/** Draft on the first line of the new side of `src/a.ts`. */
export function draftOnA(diff: PrDiff): CommentDraft {
    return {
        body: 'question about A',
        parentId: null,
        anchor: {
            fileId: fileIdOf(diff, 'src/a.ts'),
            path: 'src/a.ts',
            position: { side: 'new', line: 1, size: 1 },
        },
    };
}

/** Removes the repository template. Called in the test file's `afterAll`. */
export function disposeGitProjectTemplate(): void {
    template?.cleanup();
    template = null;
}
