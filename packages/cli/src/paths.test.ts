import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CliError } from './errors.js';
import { taskResultDirFor, taskResultFileFor, taskResultRootFor } from './paths.js';

describe('task result file', () => {
    it('root under tmp is separate for each user', () => {
        const uid = process.getuid?.();
        expect(taskResultRootFor('/tmp')).toBe(uid === undefined ? '/tmp/sherpa' : `/tmp/sherpa-${String(uid)}`);
    });

    it('directory is separate for each session and each state root', () => {
        const dir = taskResultDirFor('/tmp', '/home/u/.sherpa', 'pr-1', 'worker-a');

        expect(path.dirname(dir)).toBe(path.join(taskResultRootFor('/tmp'), 'pr-1'));
        expect(path.basename(dir)).toMatch(/^[0-9a-f]{16}$/);
        expect(taskResultDirFor('/tmp', '/home/u/.sherpa', 'pr-1', 'worker-a')).toBe(dir);
        expect(taskResultDirFor('/tmp', '/home/u/.sherpa', 'pr-1', 'worker-b')).not.toBe(dir);
        expect(taskResultDirFor('/tmp', '/home/u/dev-sherpa', 'pr-1', 'worker-a')).not.toBe(dir);
    });

    it('debug workerId with path separators cannot escape the session directory', () => {
        const dir = taskResultDirFor('/tmp', '/s', 'pr-1', '../../etc');
        expect(path.dirname(dir)).toBe(path.join(taskResultRootFor('/tmp'), 'pr-1'));
    });

    it('name is the id and attempt, extension depends on whether a schema is present', () => {
        expect(taskResultFileFor('/d', { id: 7, attempt: 2 })).toBe('/d/7-2.md');
        expect(taskResultFileFor('/d', { id: 7, attempt: 1, resultSchemaFile: '/tmp/schema.json' })).toBe('/d/7-1.json');
    });

    it('invalid PR key does not enter the path', () => {
        expect(() => taskResultDirFor('/tmp', '/s', '../etc', 'w')).toThrow(CliError);
    });
});
