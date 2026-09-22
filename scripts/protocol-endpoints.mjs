#!/usr/bin/env node
/**
 * Protocol endpoint table for `docs/protocol.md` §10.
 *
 * Paths and methods come from code: `UI_ENDPOINTS` in `packages/protocol/src/ui.ts` (method from the JSDoc
 * above the key) and `WORKER_ENDPOINTS` in `packages/protocol/src/constants.ts` (all POST). Descriptions come
 * from the `DESCRIPTIONS` map below: JSDoc in `ui.ts` describes request and response schemas, not endpoint purpose.
 * The map must match the code key for key. A new endpoint without a description or a description without an endpoint
 * fails the script, so the table cannot silently go stale.
 *
 * Usage: `node scripts/protocol-endpoints.mjs` prints to stdout,
 * `--write` replaces the content between `<!-- endpoints:start -->` and `<!-- endpoints:end -->`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI_FILE = path.join(ROOT, 'packages/protocol/src/ui.ts');
const CONSTANTS_FILE = path.join(ROOT, 'packages/protocol/src/constants.ts');
const DOC_FILE = path.join(ROOT, 'docs/protocol.md');

const START_MARKER = '<!-- endpoints:start -->';
const END_MARKER = '<!-- endpoints:end -->';

/** Endpoint purpose in one phrase. Keys match `UI_ENDPOINTS` and `WORKER_ENDPOINTS`. */
const DESCRIPTIONS = {
    ui: {
        state: 'PR state snapshot for the first render',
        enqueue: 'enqueue a task from the UI (`echo` only, development demo of the loop)',
        cancel: 'remove an enqueued task',
        events: 'SSE stream: state snapshot and review, progress, route and chat revisions',
        reviewDiff: 'PR iteration diff',
        reviewThreads: 'PR comment threads',
        reviewLenses: 'file filter lenses',
        reviewFileContent: 'file contents for context expansion',
        reviewBlob: 'image bytes by `blobId`',
        reviewProgress: 'reading progress by iteration',
        reviewFileViewed: 'mark a file as read',
        reviewStopViewed: 'mark read ranges in a stop',
        reviewViewedMirror: 'mirror the file read mark to the host',
        reviewSaveDraft: 'save a comment draft',
        reviewUpdateDraft: 'edit a comment draft',
        reviewDraftBuffer: 'buffer of drafts the host did not accept',
        reviewDraftBufferRetry: 'retry writing a buffered draft',
        reviewDraftBufferDiscard: 'discard a buffered draft',
        reviewDeleteDraft: 'delete a comment draft',
        reviewThreadResolved: 'mark a thread as resolved',
        reviewCommentResolved: 'mark a comment issue as resolved',
        reviewUpdateComment: 'edit your own published comment',
        reviewDeleteComment: 'delete your own published comment',
        reviewPublish: 'publish drafts with a verdict',
        reviewRoute: 'snapshot route',
        reviewSnapshots: 'list of route snapshots',
        reviewRouteGenerate: 'start and restart route generation',
        reviewRouteFillStop: 'refill one stop',
        reviewChat: 'chat history and agent notes',
        reviewChatAsk: 'ask the agent a question',
        reviewChatCancel: 'cancel a question',
        reviewChatRetry: 'retry a failed question',
        reviewChatNoteDelete: 'delete an agent note',
        feedback: 'reviewer feedback as an issue',
        updateCheck: 'check for a new distribution version on demand',
        settings: 'read and edit reviewer settings',
        prState: 'UI state for this PR: collapsed nodes and recent palette commands',
    },
    worker: {
        register: 'PR worker session registration',
        next: 'long-poll for the next task',
        complete: 'submit a task result',
        progress: 'task status update',
        fail: 'decline a task with a reason',
    },
};

/** Worker endpoint JSDoc has no method: it is declared once for the whole object. */
const WORKER_METHOD = 'POST';

function main() {
    const ui = parseEndpoints(read(UI_FILE), 'UI_ENDPOINTS', UI_FILE);
    const worker = parseEndpoints(read(CONSTANTS_FILE), 'WORKER_ENDPOINTS', CONSTANTS_FILE);

    assertWorkerMethod(worker);

    const markdown = [
        '### UI endpoints',
        '',
        renderTable(ui.entries, DESCRIPTIONS.ui, 'UI_ENDPOINTS', (entry) => methodsOf(entry, UI_FILE)),
        '',
        '### Worker endpoints',
        '',
        renderTable(worker.entries, DESCRIPTIONS.worker, 'WORKER_ENDPOINTS', () => WORKER_METHOD),
    ].join('\n');

    if (process.argv.includes('--write')) {
        write(markdown);
        return;
    }
    process.stdout.write(`${markdown}\n`);
}

function read(file) {
    try {
        return fs.readFileSync(file, 'utf8');
    } catch (error) {
        fail(`cannot read ${file}: ${error.message}`);
    }
}

/**
 * An object literal of the form `export const NAME = { key: '/path', ... } as const;` with JSDoc
 * above each key. Parse line by line: a full TS parser is unnecessary for fifty lines,
 * but the literal has a fixed shape. Deviations fail the script instead of silently losing an endpoint.
 */
function parseEndpoints(source, name, file) {
    const header = new RegExp(`export const ${name} = \\{\\r?\\n`).exec(source);
    if (header === null) {
        fail(`in ${file}, object ${name} was not found, check the name`);
    }

    const bodyStart = header.index + header[0].length;
    const bodyEnd = source.indexOf('\n} as const;', bodyStart);
    if (bodyEnd === -1) {
        fail(`in ${file}, the end of object ${name} was not found (line \`} as const;\`)`);
    }

    const entries = [];
    let doc = null;
    let insideDoc = false;
    for (const raw of source.slice(bodyStart, bodyEnd).split('\n')) {
        const line = raw.trim();
        if (line === '') {
            continue;
        }
        if (line.startsWith('/**')) {
            doc = line;
            insideDoc = !line.endsWith('*/');
            continue;
        }
        if (insideDoc) {
            doc += ` ${line}`;
            insideDoc = !line.endsWith('*/');
            continue;
        }

        const entry = /^(\w+):\s*'([^']+)',$/.exec(line);
        if (entry === null) {
            fail(`in ${file}, cannot parse a line in object ${name}: ${line}`);
        }
        entries.push({ key: entry[1], path: entry[2], doc: doc ?? '', object: name });
        doc = null;
    }

    if (entries.length === 0) {
        fail(`in ${file}, object ${name} is empty`);
    }
    return { entries };
}

/** Endpoint HTTP methods in the order they appear in its JSDoc. */
function methodsOf(entry, file) {
    const found = [...entry.doc.matchAll(/\b(GET|POST|PATCH|PUT|DELETE)\b/g)].map((match) => match[1]);
    const unique = [...new Set(found)];
    if (unique.length === 0) {
        fail(
            `endpoint \`${entry.key}\` in ${file} has no method in JSDoc. ` +
                'start the comment with `GET`/`POST`/`PATCH`, which supplies the table column',
        );
    }
    return unique.join(', ');
}

/** One method is declared for all worker endpoints. Check that it is still POST. */
function assertWorkerMethod(worker) {
    const source = read(CONSTANTS_FILE);
    const docStart = source.lastIndexOf('/**', source.indexOf('export const WORKER_ENDPOINTS'));
    const doc = source.slice(docStart, source.indexOf('export const WORKER_ENDPOINTS'));
    if (!doc.includes(WORKER_METHOD)) {
        fail(
            `JSDoc above WORKER_ENDPOINTS no longer mentions ${WORKER_METHOD}. ` +
                'The worker endpoint method has changed, update the script',
        );
    }
    if (worker.entries.some((entry) => !entry.path.startsWith('/api/'))) {
        fail('worker endpoint path does not start with /api/, check WORKER_ENDPOINTS');
    }
}

function renderTable(entries, descriptions, object, methodOf) {
    assertDescriptions(entries, descriptions, object);

    const rows = entries.map(
        (entry) => `| \`${entry.key}\` | \`${methodOf(entry)} ${entry.path}\` | ${descriptions[entry.key]} |`,
    );
    return ['| Key | Method and path | Purpose |', '|---|---|---|', ...rows].join('\n');
}

/** The description map must match the code key for key, or the table will silently drift. */
function assertDescriptions(entries, descriptions, object) {
    const keys = new Set(entries.map((entry) => entry.key));
    const missing = [...keys].filter((key) => descriptions[key] === undefined);
    if (missing.length > 0) {
        fail(
            `${object} has endpoints without descriptions: ${missing.join(', ')}.\n` +
                'Add them to DESCRIPTIONS in scripts/protocol-endpoints.mjs, one phrase each.',
        );
    }

    const extra = Object.keys(descriptions).filter((key) => !keys.has(key));
    if (extra.length > 0) {
        fail(
            `DESCRIPTIONS has keys that no longer exist in ${object}: ${extra.join(', ')}.\n` +
                'Remove them from scripts/protocol-endpoints.mjs.',
        );
    }
}

function write(markdown) {
    const doc = read(DOC_FILE);
    const start = doc.indexOf(START_MARKER);
    const end = doc.indexOf(END_MARKER);
    if (start === -1 || end === -1 || end < start) {
        fail(`${DOC_FILE} has no markers ${START_MARKER} … ${END_MARKER}`);
    }

    const updated = `${doc.slice(0, start + START_MARKER.length)}\n${markdown}\n${doc.slice(end)}`;
    if (updated === doc) {
        process.stdout.write('Endpoint table has not changed.\n');
        return;
    }
    fs.writeFileSync(DOC_FILE, updated);
    process.stdout.write(`Endpoint table updated: ${DOC_FILE}\n`);
}

function fail(message) {
    process.stderr.write(`protocol-endpoints: ${message}\n`);
    process.exit(1);
}

main();
