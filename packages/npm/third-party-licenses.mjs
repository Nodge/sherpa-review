import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** LICENSE, LICENCE, COPYING, with an optional `-MIT`-style suffix and `.md` or `.txt`. */
const LICENSE_FILE = /^(licen[cs]e|copying)(-\w+)?(\.(md|txt))?$/iu;
const RULE = '='.repeat(80);

/**
 * The npm package a bundled module belongs to: the name after the last `node_modules/` and the directory of that
 * package. `null` for modules outside `node_modules` (workspace sources). A virtual bundler module (`\0vite/…`)
 * belongs to the package its namespace maps to in `virtualPackages` (namespace → package directory). An unmapped
 * namespace throws, so new injected code gets a deliberate mapping.
 */
export function packageOf(modulePath, virtualPackages = {}) {
    if (modulePath.startsWith('\0')) {
        const namespace = modulePath.slice(1).split('/')[0];
        const dir = Object.hasOwn(virtualPackages, namespace) ? virtualPackages[namespace] : undefined;
        if (dir === undefined) {
            throw new Error(
                `@sherpa/npm: the bundle has code from the virtual module ${JSON.stringify(modulePath.slice(1))}, ` +
                    `and its namespace "${namespace}" maps to no package. Add it to the virtual packages in build.mjs.`,
            );
        }
        return { name: namespace, dir };
    }
    const normalized = `/${modulePath.replaceAll('\\', '/').split('?')[0]}`;
    const marker = '/node_modules/';
    const index = normalized.lastIndexOf(marker);
    if (index === -1) {
        return null;
    }
    const segments = normalized.slice(index + marker.length).split('/');
    const nameLength = segments[0].startsWith('@') ? 2 : 1;
    if (segments.length <= nameLength) {
        return null;
    }
    const name = segments.slice(0, nameLength).join('/');
    return { name, dir: `${normalized.slice(1, index)}${marker}${name}` };
}

/**
 * Inputs that contributed code to an esbuild bundle, as paths resolved against the build's working directory.
 * Inputs with no bytes in the output were tree-shaken away.
 */
export function esbuildInputs(metafile, workingDir) {
    return Object.values(metafile.outputs).flatMap((output) =>
        Object.entries(output.inputs)
            .filter(([, input]) => input.bytesInOutput > 0)
            .map(([path]) => resolve(workingDir, path)),
    );
}

/**
 * Third-party license notices for bundled modules: one section per `name@version`, sorted, with the SPDX license
 * from package.json and the full license files. Workspace packages (`@sherpa/*`) are ours. Throws for a package
 * with neither a license file nor a license field, so a new dependency cannot slip in without one.
 */
export function thirdPartyNotices(modulePaths, virtualPackages = {}) {
    const packages = new Map();
    for (const modulePath of modulePaths) {
        const found = packageOf(modulePath, virtualPackages);
        if (found === null || found.name.startsWith('@sherpa/')) {
            continue;
        }
        const manifest = JSON.parse(readFileSync(join(found.dir, 'package.json'), 'utf8'));
        packages.set(`${manifest.name}@${manifest.version}`, { manifest, dir: found.dir });
    }

    const sections = [...packages.entries()]
        .sort(([, a], [, b]) => compare(a.manifest.name, b.manifest.name) || compare(a.manifest.version, b.manifest.version))
        .map(([id, { manifest, dir }]) => {
            const license = licenseField(manifest);
            const files = readdirSync(dir).filter((file) => LICENSE_FILE.test(file)).sort();
            if (license === null && files.length === 0) {
                throw new Error(
                    `@sherpa/npm: ${id} (${dir}) is bundled but has no license file and no license field in ` +
                        'package.json. Check its terms before shipping it.',
                );
            }
            const texts = files.map((file) => readFileSync(join(dir, file), 'utf8').trim());
            return [
                RULE,
                id,
                `License: ${license ?? 'see the license text'}`,
                '-'.repeat(80),
                texts.length === 0 ? 'The package ships no license file.' : texts.join('\n\n'),
            ].join('\n');
        });

    return [
        'Third-party software bundled in sherpa-review',
        '',
        'bin/sherpa-review.mjs and bin/sherpa-review-server.mjs include code from the packages below.',
        'The IBM Plex fonts embedded in the server module are covered by LICENSE-IBM-Plex.txt.',
        '',
        ...sections.map((section) => `${section}\n`),
    ].join('\n');
}

function compare(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
}

function licenseField(manifest) {
    if (typeof manifest.license === 'string') {
        return manifest.license;
    }
    if (typeof manifest.license?.type === 'string') {
        return manifest.license.type;
    }
    return null;
}
