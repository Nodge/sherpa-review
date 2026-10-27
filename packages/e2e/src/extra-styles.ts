import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { ExtraStyleE2e } from '../../ui/src/styles/extra-style-e2e.js';

export type { ExtraStyleE2e, ExtraStyleGeometry } from '../../ui/src/styles/extra-style-e2e.js';

const EXTRA_DIR = fileURLToPath(new URL('../../ui/src/styles/extra/', import.meta.url));

/**
 * Extra styles in this UI build with their e2e expectations: `extra/<id>/` directories and their `e2e.ts` files.
 * The UI registry collects them with `import.meta.glob`. It is unavailable here, so read directories from disk.
 */
export async function loadExtraStyles(): Promise<readonly ExtraStyleE2e[]> {
    const entries = await readdir(EXTRA_DIR, { withFileTypes: true }).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return [];
        }
        throw error;
    });
    const ids = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
    const styles: ExtraStyleE2e[] = [];
    for (const id of ids) {
        const module = (await import(pathToFileURL(path.join(EXTRA_DIR, id, 'e2e.ts')).href)) as {
            readonly e2e: ExtraStyleE2e;
        };
        if (module.e2e.id !== id) {
            throw new Error(`extra/${id}/e2e.ts describes style ${module.e2e.id}`);
        }
        styles.push(module.e2e);
    }
    return styles;
}
