import type { UiGenerationCap } from '@sherpa/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
    generationCapBannerVisible,
    generationCapMissingFiles,
    GenerationCapBanner,
} from './generation-cap-banner.tsx';

/** Generation cap banner: SPEC §4.1, the plan was built from a partial diff. */

const CAP: UiGenerationCap = { filesCovered: 120, filesTotal: 505, machineFiles: 380, truncated: true };

describe('generation limit banner', () => {
    it('appears only when truncation dropped files that are not generated', () => {
        expect(generationCapBannerVisible(CAP)).toBe(true);
        expect(generationCapBannerVisible({ ...CAP, truncated: false })).toBe(false);
        expect(generationCapBannerVisible(null)).toBe(false);
    });

    it('counts missing files excluding the generated group', () => {
        expect(generationCapMissingFiles(CAP)).toBe(5);
        // More generated files than dropped files must not produce a negative count.
        expect(generationCapMissingFiles({ ...CAP, machineFiles: 500 })).toBe(0);
    });

    it('names the file count and points to the full diff without offering buttons', () => {
        const html = renderToStaticMarkup(<GenerationCapBanner cap={CAP} />);

        expect(html).toContain('The route was built from a partial diff');
        expect(html).toContain('5 files did not fit');
        expect(html).toContain('the full diff');
        expect(html).not.toContain('<button');
    });
});
