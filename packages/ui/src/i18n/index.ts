/**
 * UI localization: a dictionary without a library (M5 planning decision 1). The Russian dictionary is
 * the source of truth for keys, and the English one uses its type. Number,
 * plural and relative time formatting uses `Intl` instead of custom rules.
 *
 * A single entry point: components use `useT`/`useFormat`, pure functions use `createT` and
 * formatters with an explicit locale.
 *
 * Files outside the first pass (M5-T2) still use Russian text and call formatters with explicit `'ru'`:
 * Russian text beside a number formatted by browser rules would be inconsistent. M5-T3 will replace these
 * calls with dictionary keys. `grep "'ru')"` in `src` shows what remains.
 */

export type { Formatters } from './context.tsx';
export { LocaleProvider, useAgentLang, useFormat, useLocale, useT } from './context.tsx';
export type { PluralForms, RelativeSpan } from './format.js';
export { formatCount, formatDateTime, formatRelativeSpan, plural, relativeSpan, shortCommit } from './format.js';
export type { Dictionary, MessageKey } from './ru.js';
export { ru } from './ru.js';
export { en } from './en.js';
export type { Translate } from './translate.js';
export { createT, relativeTime, resolveLocale, translateKey } from './translate.js';
