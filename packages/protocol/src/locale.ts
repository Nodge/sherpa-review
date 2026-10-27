import { z } from 'zod';

/**
 * Sherpa languages: one UI dictionary and one required response language
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

/**
 * Text in each UI language. Needed when the server supplies a label and only the UI knows
 * the tab language. The server does not choose a language, and templates cannot inflect labels like "Open in <host>".
 */
export const localizedTextSchema = z.object({
    ru: z.string().min(1),
    en: z.string().min(1),
}) satisfies z.ZodType<Record<Locale, string>>;
export type LocalizedText = z.infer<typeof localizedTextSchema>;
