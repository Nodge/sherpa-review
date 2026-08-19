import fs from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import path from 'node:path';

/**
 * Serves the built UI. Static assets are the only content served without a token because they contain no secrets,
 * and the browser gets the token in the URL fragment without sending it to the server (rpc-design §8).
 */

/** Static paths: the root serves `index.html`, the rest are Vite build assets. */
export function isStaticPath(pathname: string): boolean {
    return pathname === '/' || pathname.startsWith('/assets/');
}

const CONTENT_TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.map': 'application/json; charset=utf-8',
};

/** Serves a build file. Returns `false` if it is missing or outside the directory (the router sends the response). */
export async function serveStatic(res: ServerResponse, uiDir: string, pathname: string): Promise<boolean> {
    const file = resolveStaticFile(uiDir, pathname);
    if (file === null) {
        return false;
    }

    let content: Buffer;
    try {
        content = await fs.readFile(file);
    } catch {
        return false;
    }

    res.writeHead(200, {
        'content-type': CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
        'content-length': String(content.byteLength),
        // Dev loop: the built UI changes under the same name, so the browser cache gets in the way.
        'cache-control': 'no-store',
    });
    res.end(content);
    return true;
}

/**
 * File path inside the UI directory. Returns `null` for an attempt to escape it.
 * `new URL` collapses `..` itself, but percent encoding survives until here,
 * so the check uses the resolved path.
 */
function resolveStaticFile(uiDir: string, pathname: string): string | null {
    let decoded: string;
    try {
        decoded = decodeURIComponent(pathname);
    } catch {
        return null;
    }

    const root = path.resolve(uiDir);
    const target = path.resolve(root, `.${decoded === '/' ? '/index.html' : decoded}`);
    if (!target.startsWith(root + path.sep)) {
        return null;
    }
    return target;
}
