import { fixtureData } from '@sherpa/fixtures';
import type { Thread } from '@sherpa/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { createThreadStore } from './store.js';
import { ThreadList } from './thread-list.tsx';

/**
 * Comment bodies render as markdown (M2F-T5). Bots write headings, lists,
 * links and code blocks, and the thread card must render that markup instead of a raw string.
 */

const DATA = fixtureData('medium');
const FILE_IDS = new Set(DATA.diff.files.map((file) => file.fileId));
const NOW = Date.parse('2026-08-24T12:00:00.000Z');

const TRANSPORT = {
    save: () => Promise.reject(new Error('this test does not save')),
    update: () => Promise.reject(new Error('this test does not save')),
    delete: () => Promise.reject(new Error('this test does not save')),
};

function render(threads: readonly Thread[]): string {
    return renderToStaticMarkup(
        <ThreadList
            threads={threads}
            store={createThreadStore(threads, FILE_IDS)}
            actions={{ transport: TRANSPORT, resolve: () => Promise.resolve(true) }}
            now={NOW}
        />,
    );
}

function threadOf(login: string): Thread {
    const thread = DATA.threads.find((candidate) => candidate.root.author.login === login);
    if (thread === undefined) {
        throw new Error(`the medium fixture has no thread by ${login}`);
    }
    return thread;
}

describe('comment body', () => {
    it('renders bot markup as elements: heading, list, link, code block', () => {
        const html = render([threadOf('ai-review-bot')]);
        const body = html.slice(html.indexOf('thread__body'));

        expect(body).toContain('<p class="md-heading">PCI: unmasked PAN in retained logs</p>');
        expect(body).toContain('<ul class="md-list">');
        expect(body).toContain('<strong>Severity:</strong>');
        expect(body).toContain('<code class="md-code">logs/checkout-*.jsonl</code>');
        expect(body).toContain('<pre class="md-pre">');
        // A bare URL opens a link in a new tab without a referrer.
        expect(body).toContain('target="_blank" rel="noreferrer"');
        expect(body).not.toContain('`');
    });

    it('renders a bracketed link as a link instead of text', () => {
        const body = render([threadOf('lint-bot')]);

        expect(body).toContain(
            '<a class="md-link" href="https://eslint.org/docs/latest/rules/no-fallthrough" target="_blank" rel="noreferrer">no-fallthrough</a>',
        );
    });

    it('keeps plain human text in a single paragraph', () => {
        const body = render([threadOf('kai')]);

        expect(body).toContain('<p class="md-p">Why is the window a class');
        expect(body).toContain('<code class="md-code">Clock</code>');
    });
});
