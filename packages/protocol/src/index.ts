/**
 * C1↔C2 contract (rpc-design §3–§5, §9, spec §5).
 * Zod schemas are canonical. Types are inferred from them, JSON schemas are generated from them.
 */
export * from './constants.js';
export * from './json-schema.js';
export * from './manifest.js';
export * from './messages.js';
export * from './task.js';
export * from './ui.js';
export * from './version.js';
