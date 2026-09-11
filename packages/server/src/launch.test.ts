import fs from 'node:fs/promises';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { formatUiUrl, isDirectory, readOption, resolveUiDir, UI_BUILD_HINT } from './launch.js';
import { makeTempSherpaDir, removeTempSherpaDir } from './test-support.js';

/** Parses development launch arguments and finds the built UI. */
describe('server launch', () => {
    let tempDir: string;

    beforeEach(async () => {
        tempDir = await makeTempSherpaDir();
    });

    afterEach(async () => {
        await removeTempSherpaDir(tempDir);
    });

    describe('reading an option', () => {
        it('returns the value after the flag', () => {
            expect(readOption(['--pr', 'github-quillmart--quillmart--42', '--ui', 'dist'], '--pr')).toBe('github-quillmart--quillmart--42');
            expect(readOption(['--pr', 'github-quillmart--quillmart--42', '--ui', 'dist'], '--ui')).toBe('dist');
        });

        it('returns no value when the flag is the last argument', () => {
            expect(readOption(['--pr'], '--pr')).toBeNull();
            expect(readOption(['--ui', 'dist', '--pr'], '--pr')).toBeNull();
        });

        it('returns null when the flag is absent', () => {
            expect(readOption([], '--pr')).toBeNull();
            expect(readOption(['--ui', 'dist'], '--pr')).toBeNull();
        });

        it('uses the first occurrence of a repeated flag', () => {
            expect(readOption(['--pr', 'first', '--pr', 'second'], '--pr')).toBe('first');
        });
    });

    describe('UI URL', () => {
        it('wraps an IPv6 address in square brackets', () => {
            expect(formatUiUrl(4317, 'token', '::1')).toBe('UI: http://[::1]:4317/#t=token');
        });
    });

    describe('UI directory', () => {
        it('reports a missing --ui with an absolute path and a build hint', async () => {
            const missing = path.join(tempDir, 'does-not-exist');

            await expect(resolveUiDir(missing)).rejects.toThrow(UI_BUILD_HINT);
            await expect(resolveUiDir(missing)).rejects.toThrow(missing);
        });

        it('reports the absolute path instead of the command-line input', async () => {
            // A relative name beside cwd: the directory is absent, and the name does not contain its absolute form.
            const relative = 'no-such-ui-directory';
            const absolute = path.resolve(relative);
            expect(await isDirectory(absolute)).toBe(false);

            await expect(resolveUiDir(relative)).rejects.toThrow(absolute);
        });

        it('resolves a relative --ui from the current directory', async () => {
            const uiDir = path.join(tempDir, 'dist');
            await fs.mkdir(uiDir);
            const relative = path.relative(process.cwd(), uiDir);

            expect(path.isAbsolute(relative)).toBe(false);
            await expect(resolveUiDir(relative)).resolves.toBe(uiDir);
        });

        it('returns an existing --ui as is', async () => {
            const uiDir = path.join(tempDir, 'ui-dist');
            await fs.mkdir(uiDir);

            await expect(resolveUiDir(uiDir)).resolves.toBe(uiDir);
        });
    });

    describe('directory check', () => {
        it('accepts a directory and rejects a file or a missing path', async () => {
            const dir = path.join(tempDir, 'directory');
            const file = path.join(tempDir, 'file.txt');
            await fs.mkdir(dir);
            await fs.writeFile(file, 'not a directory');

            await expect(isDirectory(dir)).resolves.toBe(true);
            await expect(isDirectory(file)).resolves.toBe(false);
            await expect(isDirectory(path.join(tempDir, 'does-not-exist'))).resolves.toBe(false);
        });
    });

    describe('UI link', () => {
        it('puts the token in the fragment so it never reaches the server', () => {
            expect(formatUiUrl(41234, 'secret-token')).toBe('UI: http://127.0.0.1:41234/#t=secret-token');
        });
    });
});
