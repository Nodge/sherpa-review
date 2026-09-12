import { describe, expect, it } from 'vitest';

import type { StaticAssets } from './static.js';
import { injectDocumentSettings, withDocumentSettings } from './ui-document.js';

const INDEX = [
    '<!doctype html>',
    '<html lang="ru">',
    '    <head>',
    '        <meta charset="utf-8" />',
    '        <link rel="stylesheet" href="/assets/app.css" />',
    '    </head>',
    '    <body><div id="root"></div></body>',
    '</html>',
].join('\n');

describe('document state in index.html', () => {
    it('passes an explicit theme as an attribute, with no script in the document', () => {
        const html = injectDocumentSettings(INDEX, { theme: 'light', textSize: 'm' });

        expect(html).toContain('<html lang="ru" data-textsize="m" data-theme="light">');
        expect(html).not.toContain('<script>');
    });

    it('sets the text size on `<html>` with any theme', () => {
        expect(injectDocumentSettings(INDEX, { theme: 'dark', textSize: 'l' })).toContain('data-textsize="l"');
        expect(injectDocumentSettings(INDEX, { theme: 'auto', textSize: 'l' })).toContain('data-textsize="l"');
    });

    it('auto: places the script first in `<head>`, before stylesheets', () => {
        const html = injectDocumentSettings(INDEX, { theme: 'auto', textSize: 'm' });

        expect(html).not.toContain('data-theme=');
        expect(html).toContain('prefers-color-scheme: dark');
        expect(html.indexOf('<script>')).toBeLessThan(html.indexOf('<link rel="stylesheet"'));
        expect(html.indexOf('<head>')).toBeLessThan(html.indexOf('<script>'));
    });

    it('replaces existing document attributes without duplicating them', () => {
        const stale = INDEX.replace('<html lang="ru">', '<html lang="ru" data-theme=\'dark\' data-textsize=l>');

        const html = injectDocumentSettings(stale, { theme: 'light', textSize: 'm' });

        expect(html).toContain('<html lang="ru" data-textsize="m" data-theme="light">');
        expect([...html.matchAll(/data-theme=/g)]).toHaveLength(1);
        expect([...html.matchAll(/data-textsize=/g)]).toHaveLength(1);
    });

    it('minimal document: tag case and a missing `<head>` do not break injection', () => {
        const upper = injectDocumentSettings('<!DOCTYPE HTML><HTML><BODY>x</BODY></HTML>', {
            theme: 'auto',
            textSize: 'm',
        });

        expect(upper).toContain('data-textsize="m"');
        // The browser opens `<head>` itself, so the script ends up inside it as long as it precedes the body.
        expect(upper.indexOf('<script>')).toBeLessThan(upper.indexOf('<BODY>'));
    });

    it('leaves a document without `<html>` unchanged: nowhere to inject', () => {
        const raw = '<!doctype html><title>Sherpa</title>';

        expect(injectDocumentSettings(raw, { theme: 'light', textSize: 'l' })).toBe(raw);
    });

    it('static asset wrapper modifies only index.html and reads settings on every request', async () => {
        let theme: 'auto' | 'dark' | 'light' = 'light';
        const assets = withDocumentSettings(staticAssets({ '/index.html': INDEX, '/assets/app.css': 'body{}' }), () => ({
            theme,
            textSize: 'm',
        }));

        const light = await assets.read('/');
        theme = 'dark';
        const dark = await assets.read('/index.html');
        const css = await assets.read('/assets/app.css');

        expect(light?.content.toString('utf8')).toContain('data-theme="light"');
        expect(dark?.content.toString('utf8')).toContain('data-theme="dark"');
        expect(light?.contentType).toContain('text/html');
        expect(css?.content.toString('utf8')).toBe('body{}');
        expect(await assets.read('/assets/missing.css')).toBeNull();
    });
});

/** Map of "build path → contents": `read` receives an already normalized path here. */
function staticAssets(files: Readonly<Record<string, string>>): StaticAssets {
    return {
        read: (pathname) => {
            const file = files[pathname === '/' ? '/index.html' : pathname];
            return Promise.resolve(
                file === undefined
                    ? null
                    : {
                          content: Buffer.from(file, 'utf8'),
                          contentType: pathname.endsWith('.css')
                              ? 'text/css; charset=utf-8'
                              : 'text/html; charset=utf-8',
                      },
            );
        },
    };
}
