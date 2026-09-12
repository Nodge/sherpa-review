import type { UiSettings } from '@sherpa/protocol';

import type { StaticAssets } from './static.js';

/**
 * Document state in the served `index.html`. Theme and text size are injected at request
 * time: waiting for `GET /api/ui/settings` would produce a second frame in a different theme
 * (decision in `docs/decisions.md`, 2026-09-12). There is no value to inject for `auto`, because only
 * the browser knows the system theme, so a short script is embedded in `<head>`. It sets the attribute
 * before stylesheets load, then the UI manages the theme (`settings/document-settings.tsx`).
 */

/** Settings visible in the first frame. */
export type DocumentSettings = Pick<UiSettings, 'theme' | 'textSize'>;

const HTML_OPEN_TAG = /<html\b[^>]*>/i;
const HEAD_OPEN_TAG = /<head\b[^>]*>/i;
const DOCUMENT_ATTRIBUTES = /\s+data-(?:theme|textsize)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;

/** The UI runtime reads the same request (`settings/document-settings.tsx`). */
const AUTO_THEME_SCRIPT =
    '<script>document.documentElement.setAttribute("data-theme",' +
    'window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light")</script>';

/** UI static assets that serve `index.html` with document state injected. */
export function withDocumentSettings(assets: StaticAssets, readSettings: () => DocumentSettings): StaticAssets {
    return {
        read: async (pathname) => {
            const asset = await assets.read(pathname);
            if (asset === null || !isIndexDocument(pathname)) {
                return asset;
            }
            const html = injectDocumentSettings(asset.content.toString('utf8'), readSettings());
            return { content: Buffer.from(html, 'utf8'), contentType: asset.contentType };
        },
    };
}

/**
 * Sets `data-theme` (for an explicit theme only) and `data-textsize` on `<html>`. In `auto` mode,
 * adds a script first in `<head>`. A document without `<html>` stays unchanged: nowhere to inject.
 */
export function injectDocumentSettings(html: string, settings: DocumentSettings): string {
    const tag = HTML_OPEN_TAG.exec(html);
    if (tag === null) {
        return html;
    }

    const attributes = [`data-textsize="${settings.textSize}"`];
    if (settings.theme !== 'auto') {
        attributes.push(`data-theme="${settings.theme}"`);
    }
    const withAttributes = html.replace(HTML_OPEN_TAG, () => rewriteHtmlTag(tag[0], attributes));
    return settings.theme === 'auto' ? withAutoThemeScript(withAttributes) : withAttributes;
}

function isIndexDocument(pathname: string): boolean {
    return pathname === '/' || pathname === '/index.html';
}

/** Our attributes replace existing ones: repeated injection must not leave 2 `data-theme` attributes. */
function rewriteHtmlTag(tag: string, attributes: readonly string[]): string {
    const stripped = tag.slice(0, -1).replace(DOCUMENT_ATTRIBUTES, '').trimEnd();
    return `${stripped} ${attributes.join(' ')}>`;
}

/** The script goes first in `<head>`: it must run before stylesheets, or the first frame changes color. */
function withAutoThemeScript(html: string): string {
    const head = HEAD_OPEN_TAG.exec(html);
    if (head !== null) {
        return html.replace(HEAD_OPEN_TAG, () => `${head[0]}${AUTO_THEME_SCRIPT}`);
    }
    // `<head>` is optional in the document: the browser opens it itself, placing the script inside.
    return html.replace(HTML_OPEN_TAG, (tag) => `${tag}${AUTO_THEME_SCRIPT}`);
}
