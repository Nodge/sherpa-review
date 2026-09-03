import { z } from 'zod';

/**
 * Sherpa languages (M5, planning decision 1): one UI dictionary and one required answer language
 * for generation. Anything other than `ru` resolves to `en`. There is no third language.
 */
export const localeSchema = z.enum(['ru', 'en']);
export type Locale = z.infer<typeof localeSchema>;

/**
 * Language setting: `auto` uses the browser's `navigator.languages` (first `ru*` → `ru`,
 * otherwise `en`), explicit `ru`/`en` overrides the browser.
 */
export const localeSettingSchema = z.enum(['auto', ...localeSchema.options]);
export type LocaleSetting = z.infer<typeof localeSettingSchema>;
