/**
 * UI localization: a custom dictionary without a library. The Russian dictionary is
 * the source of truth for keys, and the English one uses its type. Number,
 * plural and relative time formatting uses `Intl` instead of custom rules.
 *
 * There is one entry point: components use `useT`/`useFormat`, pure models take `Translate` as an argument
 * (or return `MessageKey`), and code outside the React tree uses `activeT`.
 *
 * `no-cyrillic.test.ts` checks translation completeness: no Cyrillic outside comments
 * is allowed in `packages/ui/src`.
 */

export type { Formatters } from './context.tsx';
export { LocaleProvider, useAgentLang, useFormat, useLocale, useT } from './context.tsx';
export type { PluralForms, RelativeSpan } from './format.js';
export { formatCount, formatDateTime, formatRelativeSpan, plural, relativeSpan, shortCommit } from './format.js';
export type { Dictionary, MessageKey } from './ru.js';
export { ru } from './ru.js';
export { en } from './en.js';
export type { Translate } from './translate.js';
export { activeT, createT, localized, relativeTime, resolveLocale, setActiveLocale, translateKey } from './translate.js';
