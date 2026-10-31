import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { localPrKeyPrefix } from '@sherpa/protocol';

import type { CommandRunner } from './command.js';
import { runCommand } from './command.js';
import { CliError } from './errors.js';
import type { CliHostPlugin, LocalDetection, LocalDetector } from './hosts/plugin.js';

/**
 * Local review from a project directory (`sherpa-review up --local <path>`): which VCS, which directory,
 * which branch and which key identifies it. All of this is resolved here, not on the server. Only
 * the command's caller knows the directory, and the VCS kind reaches the server as the key prefix.
 * Host plugins (`LocalDetector`) know which VCS kinds exist. This module doesn't.
 */

/** Number of hash characters in the key. 32 bits are more than enough to distinguish adjacent branches. */
const KEY_HASH_CHARS = 8;

/** Fallback directory name in the key when no allowed characters remain in the base name. */
const FALLBACK_DIR_NAME = 'dir';

export interface LocalTarget {
    /** Review key, also the name of the state directory and manifest. */
    readonly prKey: string;
    /** How this directory is versioned: the VCS kind from the plugin. */
    readonly vcs: string;
    /** Project directory resolved to an absolute path through realpath. */
    readonly repo: string;
    readonly branch: string;
    /** Explicit base from `--base`. With undefined, the server computes the default base. */
    readonly base: string | undefined;
    /** How the server computes the base without `--base`, in the VCS plugin wording. */
    readonly defaultBase: string;
}

/**
 * Project directory → review key. Selects the VCS kind from the listed plugins: first the one whose marker
 * is directly in the directory (`ownsDirectory`: a nested repository is closer than an enclosing checkout), then
 * the first plugin in list order to recognize its checkout in the directory. Each plugin is queried at most
 * once. A missing directory, a non-directory or a non-checkout produces a clear error. Further down the chain this
 * would turn into "server failed to start".
 */
export async function resolveLocalTarget(
    rawPath: string,
    base: string | undefined,
    hosts: readonly CliHostPlugin[],
    run: CommandRunner = runCommand,
): Promise<LocalTarget> {
    const repo = await realDirectory(rawPath);
    const detectors = hosts.flatMap((host) => (host.detectLocal === undefined ? [] : [host.detectLocal]));
    if (detectors.length === 0) {
        throw new CliError(
            'sherpa-review: this Sherpa build knows no version control system for local review.\n' +
                'Pass `--pr <pr key>` to review a PR instead.',
        );
    }

    const answers = new Map<LocalDetector, LocalDetection>();
    const ask = async (detector: LocalDetector): Promise<LocalDetection> => {
        const known = answers.get(detector);
        if (known !== undefined) {
            return known;
        }
        const answer = await detector.detect(repo, run);
        answers.set(detector, answer);
        return answer;
    };

    for (const detector of detectors) {
        if ((await detector.ownsDirectory?.(repo)) === true) {
            const answer = await ask(detector);
            if (answer.kind === 'found') {
                return targetOf(detector, repo, answer.branch, base);
            }
        }
    }

    for (const detector of detectors) {
        const answer = await ask(detector);
        if (answer.kind === 'found') {
            return targetOf(detector, repo, answer.branch, base);
        }
    }

    throw new CliError(notACheckout(repo, detectors, answers));
}

/**
 * Local review key: VCS kind and directory name for readability, plus a hash of the path, branch
 * and explicit base to distinguish reviews. Together these three define the review. A different branch or
 * base means a different diff, and a running server for the old key would return something other than what was requested.
 */
export function localPrKey(vcs: string, repo: string, branch: string, base?: string): string {
    const digest = createHash('sha256')
        .update(`${repo}\n${branch}\n${base ?? ''}`)
        .digest('hex');
    return `${localPrKeyPrefix(vcs)}${keyNameOf(path.basename(repo))}-${digest.slice(0, KEY_HASH_CHARS)}`;
}

function targetOf(detector: LocalDetector, repo: string, branch: string, base: string | undefined): LocalTarget {
    const { vcs, defaultBase } = detector;
    return { prKey: localPrKey(vcs, repo, branch, base), vcs, repo, branch, base, defaultBase };
}

async function realDirectory(rawPath: string): Promise<string> {
    const candidate = path.resolve(rawPath);

    let real: string;
    try {
        real = await fs.realpath(candidate);
    } catch {
        throw new CliError(
            `sherpa-review: there is no directory ${candidate}.\n` +
                'Pass the path of the project directory to review: `sherpa-review up --local <path>`.',
        );
    }

    const stats = await fs.stat(real).catch(() => null);
    if (stats?.isDirectory() !== true) {
        throw new CliError(
            `sherpa-review: ${candidate} is not a directory.\n` +
                'Pass the path of the project directory to review: `sherpa-review up --local <path>`.',
        );
    }
    return real;
}

/** No VCS recognized the directory. The rejection includes all reasons to show exactly what is missing. */
function notACheckout(
    repo: string,
    detectors: readonly LocalDetector[],
    answers: ReadonlyMap<LocalDetector, LocalDetection>,
): string {
    const kinds = detectors.map((detector) => detector.vcs);
    const reasons = detectors.flatMap((detector) => {
        const answer = answers.get(detector);
        return answer?.kind === 'absent' ? [answer.reason] : [];
    });
    const named = kinds.join(' or ');
    return (
        `sherpa-review: ${repo} is not inside ${articleOf(named)} ${named} checkout` +
        (reasons.length === 0 ? '' : ` (${reasons.join('; ')})`) +
        '.\n' +
        `Local review reads the working tree with ${kinds.map((kind) => `\`${kind}\``).join(' or ')}; ` +
        'run it from a checkout or pass `--pr <pr key>`.'
    );
}

function articleOf(word: string): string {
    return /^[aeiou]/iu.test(word) ? 'an' : 'a';
}

/** Directory name in the `prKeySchema` character set. Replaces other characters with hyphens, uses `dir` for an empty name. */
function keyNameOf(basename: string): string {
    const sanitized = basename.replace(/[^A-Za-z0-9._-]/gu, '-');
    return sanitized === '' ? FALLBACK_DIR_NAME : sanitized;
}
