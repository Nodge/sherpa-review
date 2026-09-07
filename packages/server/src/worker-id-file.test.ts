import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RpcFailure } from './errors.js';
import { makeTempSherpaDir, removeTempSherpaDir } from './test-support.js';
import { writeWorkerIdFile } from './worker-id-file.js';

/** Session identity file: the next CLI call reads it, so both contents and permissions matter. */
describe('worker identity file', () => {
    let tempDir: string;
    let stateDir: string;
    let filePath: string;

    beforeEach(async () => {
        tempDir = await makeTempSherpaDir();
        stateDir = path.join(tempDir, 'state');
        filePath = path.join(stateDir, 'worker-id');
    });

    afterEach(async () => {
        await removeTempSherpaDir(tempDir);
    });

    function modeOf(target: string): number {
        return fs.statSync(target).mode & 0o777;
    }

    it('writes the id with a newline and permissions 0600', () => {
        writeWorkerIdFile(filePath, 'w-42');

        // Exactly `<id>\n`: the reader strips exactly one newline.
        expect(fs.readFileSync(filePath, 'utf8')).toBe('w-42\n');
        expect(modeOf(filePath)).toBe(0o600);
    });

    it('overwriting another file restores permissions 0600', () => {
        fs.mkdirSync(stateDir, { recursive: true });
        fs.writeFileSync(filePath, 'w-old\n', { mode: 0o644 });
        fs.chmodSync(filePath, 0o644);

        writeWorkerIdFile(filePath, 'w-new');

        expect(fs.readFileSync(filePath, 'utf8')).toBe('w-new\n');
        // `writeFileSync` leaves existing file permissions alone, so an explicit chmod sets them.
        expect(modeOf(filePath)).toBe(0o600);
    });

    it('recreates a deleted state directory with permissions 0700', () => {
        writeWorkerIdFile(filePath, 'w-1');
        fs.rmSync(stateDir, { recursive: true, force: true });

        writeWorkerIdFile(filePath, 'w-2');

        expect(fs.readFileSync(filePath, 'utf8')).toBe('w-2\n');
        expect(modeOf(stateDir)).toBe(0o700);
    });

    it('directory at the file path throws RpcFailure with code internal and the path in the message', () => {
        fs.mkdirSync(filePath, { recursive: true });

        try {
            writeWorkerIdFile(filePath, 'w-1');
            expect.unreachable('writing over a directory must fail');
        } catch (error) {
            expect(error).toBeInstanceOf(RpcFailure);
            expect((error as RpcFailure).code).toBe('internal');
            expect((error as RpcFailure).message).toContain(filePath);
        }
    });
});
