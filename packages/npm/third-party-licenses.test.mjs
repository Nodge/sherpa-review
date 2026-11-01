import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { assetSources, esbuildInputs, packageOf, thirdPartyNotices } from './third-party-licenses.mjs';

describe('packageOf', () => {
    it('takes the package after the last node_modules in the pnpm layout', () => {
        expect(packageOf('/repo/node_modules/.pnpm/react-dom@19.3.1/node_modules/react-dom/cjs/client.js')).toEqual({
            name: 'react-dom',
            dir: '/repo/node_modules/.pnpm/react-dom@19.3.1/node_modules/react-dom',
        });
    });

    it('keeps the scope of a scoped package', () => {
        expect(packageOf('/r/node_modules/.pnpm/@tanstack+virtual-core@3.19.9/node_modules/@tanstack/virtual-core/dist/index.js'))
            .toEqual({
                name: '@tanstack/virtual-core',
                dir: '/r/node_modules/.pnpm/@tanstack+virtual-core@3.19.9/node_modules/@tanstack/virtual-core',
            });
    });

    it('works for relative esbuild paths, Windows separators and query suffixes', () => {
        expect(packageOf('../../node_modules/zod/v4/index.js')?.dir).toBe('../../node_modules/zod');
        expect(packageOf(String.raw`C:\r\node_modules\diff\lib\index.mjs`)?.dir).toBe('C:/r/node_modules/diff');
        expect(packageOf('/r/node_modules/react/index.js?commonjs-proxy')?.name).toBe('react');
    });

    it('skips workspace sources', () => {
        expect(packageOf('/repo/packages/protocol/src/chat.ts')).toBeNull();
        expect(packageOf('/r/node_modules/.pnpm')).toBeNull();
    });

    it('maps a virtual module to the package of its namespace', () => {
        const virtual = { vite: '/r/node_modules/vite', rolldown: '/r/node_modules/rolldown' };

        expect(packageOf('\0vite/preload-helper.js', virtual)).toEqual({ name: 'vite', dir: '/r/node_modules/vite' });
        expect(packageOf('\0rolldown/runtime.js', virtual)?.dir).toBe('/r/node_modules/rolldown');
    });

    it('fails on a virtual module whose namespace maps to no package', () => {
        expect(() => packageOf('\0commonjsHelpers.js', { vite: '/r/node_modules/vite' })).toThrow(
            /"commonjsHelpers\.js" maps to no package/u,
        );
        expect(() => packageOf('\0toString/x.js')).toThrow(/"toString" maps to no package/u);
    });
});

describe('assetSources', () => {
    const UI = '/repo/packages/ui';
    const FONT = '/repo/node_modules/.pnpm/@ibm+plex-sans@1.1.0/node_modules/@ibm/plex-sans/fonts/a.woff2';

    it('returns package and own sources, and accepts worker bundles without one', () => {
        const assets = {
            'assets/a.woff2': [FONT],
            'assets/mark.svg': [`${UI}/src/assets/mark.svg`],
            'assets/worker.js': [],
        };

        expect(assetSources(assets, UI, ['assets/worker.js'])).toEqual([FONT, `${UI}/src/assets/mark.svg`]);
        expect(packageOf(FONT)?.name).toBe('@ibm/plex-sans');
    });

    it('fails on an asset without a known source', () => {
        expect(() => assetSources({ 'assets/x.png': [] }, UI, [])).toThrow(/assets\/x\.png with no known source/u);
    });

    it('fails on a sourceless JS asset that no worker build produced', () => {
        expect(() => assetSources({ 'assets/vendor-helper.js': [] }, UI, ['assets/worker.js'])).toThrow(
            /assets\/vendor-helper\.js with no known source/u,
        );
    });

    it('fails on a source outside node_modules and the UI package', () => {
        expect(() => assetSources({ 'assets/x.png': ['/elsewhere/x.png'] }, UI, [])).toThrow(/outside node_modules/u);
        expect(() => assetSources({ 'assets/x.png': ['/repo/packages/ui-other/x.png'] }, UI, [])).toThrow(/outside/u);
    });
});

describe('esbuildInputs', () => {
    it('resolves inputs that reached the output against the working directory', () => {
        const metafile = {
            outputs: {
                'dist/out.mjs': { inputs: { 'src/a.ts': { bytesInOutput: 10 }, '../x/shaken.js': { bytesInOutput: 0 } } },
            },
        };

        expect(esbuildInputs(metafile, '/repo/packages/cli')).toEqual(['/repo/packages/cli/src/a.ts']);
    });
});

describe('thirdPartyNotices', () => {
    let root;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'sherpa-notices-'));
    });

    afterEach(() => {
        rmSync(root, { recursive: true, force: true });
    });

    function fakePackage(name, manifest, files = {}) {
        const dir = join(root, 'node_modules', name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...manifest }));
        for (const [file, text] of Object.entries(files)) {
            writeFileSync(join(dir, file), text);
        }
        return join(dir, 'index.js');
    }

    it('lists each package once, sorted, with its license and text, without workspace packages', () => {
        const b = fakePackage('b-pkg', { license: 'ISC' }, { 'LICENSE-MIT.txt': 'b text' });
        const a = fakePackage('a-pkg', { license: { type: 'MIT' } }, { license: 'a text' });
        const ours = fakePackage('@sherpa/protocol', { license: 'MIT' }, { LICENSE: 'ours' });

        const notices = thirdPartyNotices([b, a, `${a}x`, ours]);

        expect(notices.match(/^a-pkg@1\.0\.0\nLicense: MIT\n-+\na text$/mu)).not.toBeNull();
        expect(notices.match(/^b-pkg@1\.0\.0\nLicense: ISC\n-+\nb text$/mu)).not.toBeNull();
        expect(notices.indexOf('a-pkg@')).toBeLessThan(notices.indexOf('b-pkg@'));
        expect(notices.split('a-pkg@1.0.0')).toHaveLength(2);
        expect(notices).not.toContain('@sherpa/');
    });

    it('fails for a package with neither a license file nor a license field', () => {
        const bare = fakePackage('bare', {});

        expect(() => thirdPartyNotices([bare])).toThrow(/bare@1\.0\.0 .* no license file and no license field/u);
    });
});
