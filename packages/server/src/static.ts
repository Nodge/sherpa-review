import fs from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import path from 'node:path';

/**
 * Serves the built UI. Static assets are the only content served without a token because they contain no secrets,
 * and the browser gets the token in the URL fragment without sending it to the server (rpc-design §8).
 */

/** UI build file ready to send. */
export interface StaticAsset {
    readonly content: Buffer;
    readonly contentType: string;
}

/**
 * UI static asset source with two implementations: a build directory on disk (development) and a file map
 * embedded in the server bundle at build time (skill distribution). The router sees no difference.
 */
export interface StaticAssets {
    /** `null` means the file isn't in the UI build. */
    readonly read: (pathname: string) => Promise<StaticAsset | null>;
}

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

export function contentTypeOf(file: string): string {
    return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/** Static assets from disk: development server under tsx, using the `packages/ui/dist` directory. */
export function directoryAssets(uiDir: string): StaticAssets {
    const root = path.resolve(uiDir);

    return {
        read: async (pathname) => {
            const relative = normalizeStaticPath(pathname);
            if (relative === null) {
                return null;
            }

            // `new URL` resolves `..` itself, but percent encoding survives until here,
            // so check the resolved path.
            const file = path.resolve(root, `.${relative}`);
            if (!file.startsWith(root + path.sep)) {
                return null;
            }

            try {
                return { content: await fs.readFile(file), contentType: contentTypeOf(file) };
            } catch {
                return null;
            }
        },
    };
}

/**
 * Static assets in memory: a "path → base64" map embedded in the server bundle at build time.
 * The skill distribution has 2 files, with no `ui/dist` directory beside them.
 */
export function bundledAssets(files: Readonly<Record<string, string>>): StaticAssets {
    const decoded = new Map<string, StaticAsset>();
    for (const [pathname, base64] of Object.entries(files)) {
        decoded.set(pathname, { content: Buffer.from(base64, 'base64'), contentType: contentTypeOf(pathname) });
    }

    return {
        read: (pathname) => {
            const relative = normalizeStaticPath(pathname);
            return Promise.resolve(relative === null ? null : (decoded.get(relative) ?? null));
        },
    };
}

/** Serves a build file. `false` means it is missing or the path leaves the build directory (the router responds). */
export async function serveStatic(res: ServerResponse, assets: StaticAssets, pathname: string): Promise<boolean> {
    const asset = await assets.read(pathname);
    if (asset === null) {
        return false;
    }

    res.writeHead(200, {
        'content-type': asset.contentType,
        'content-length': String(asset.content.byteLength),
        // Dev loop: the built UI changes under the same name, so the browser cache gets in the way.
        'cache-control': 'no-store',
    });
    res.end(asset.content);
    return true;
}

/** Maps a request path to a UI build path (`/` → `/index.html`). `null` means the path cannot be decoded. */
function normalizeStaticPath(pathname: string): string | null {
    let decoded: string;
    try {
        decoded = decodeURIComponent(pathname);
    } catch {
        return null;
    }
    return decoded === '/' ? '/index.html' : decoded;
}
