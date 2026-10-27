import { uiSettingsSchema } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import type { ExtraStyleE2e } from './extra-style-e2e.js';
import { EXTRA_STYLES } from './extra-styles.js';

const E2E = import.meta.glob<{ readonly e2e: ExtraStyleE2e }>('./extra/*/e2e.ts', { eager: true });

/** Real registry, no mock: the style id goes into settings and must pass the protocol schema. */
describe('extra style registry', () => {
    it('every style id passes the settings schema and is unique', () => {
        const ids = EXTRA_STYLES.map((style) => style.id);
        for (const id of ids) {
            expect(uiSettingsSchema.shape.style.safeParse(id).success, id).toBe(true);
        }
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('every style has e2e expectations with the same id and label', () => {
        const described = Object.values(E2E).map(({ e2e }) => ({ id: e2e.id, label: e2e.label }));
        expect(described).toEqual(EXTRA_STYLES.map((style) => ({ id: style.id, label: style.label })));
    });
});
