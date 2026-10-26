import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { RESULT_MAX_BYTES } from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readResultFile } from './cli.js';
import { CliError } from './errors.js';

const TARGET = { cliPath: '/opt/sherpa/sherpa.mjs', prKey: 'github-quillmart--quillmart--1' };

describe('result size precheck', () => {
    let workDir: string;

    beforeEach(async () => {
        workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sherpa-cli-result-'));
    });

    afterEach(async () => {
        await fs.rm(workDir, { recursive: true, force: true });
    });

    async function writeResult(name: string, content: string): Promise<string> {
        const file = path.join(workDir, name);
        await fs.writeFile(file, content);
        return file;
    }

    it('accepts exactly the limit, rejects one byte over it', async () => {
        const atLimit = await writeResult('at-limit.md', 'a'.repeat(RESULT_MAX_BYTES));
        const overLimit = await writeResult('over-limit.md', 'a'.repeat(RESULT_MAX_BYTES + 1));

        await expect(readResultFile(atLimit, 42, TARGET)).resolves.toHaveLength(RESULT_MAX_BYTES);
        await expect(readResultFile(overLimit, 42, TARGET)).rejects.toThrow('the limit is 256 KB');
    });

    it('counts size in bytes, not characters', async () => {
        // 'é' takes two bytes in UTF-8. By string length, the file would fit within the limit.
        const file = await writeResult('utf8.md', 'é'.repeat(RESULT_MAX_BYTES / 2 + 1));

        await expect(readResultFile(file, 42, TARGET)).rejects.toThrow(CliError);
    });

    it('missing file or a directory: clear error with a hint', async () => {
        const missing = path.join(workDir, 'missing.md');
        await expect(readResultFile(missing, 42, TARGET)).rejects.toThrow(
            `Write the result to ${missing} and call ` +
                `\`node /opt/sherpa/sherpa.mjs task complete 42 --file '${missing}' --pr github-quillmart--quillmart--1\` again.`,
        );
        await expect(readResultFile(workDir, 42, TARGET)).rejects.toThrow('is not a file');
    });
});
