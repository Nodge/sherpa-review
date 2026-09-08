/**
 * Route generation result validator. Pure modules with no DB, network or queue.
 * Orchestration calls them on `task complete` and stores accepted results in the snapshot.
 */
export { indexDiff, sideLines, touchesChangedLines } from './diff-index.js';
export type { ChangedFile, DiffIndex } from './diff-index.js';
export { stripCodeFence } from './raw-result.js';
export { OTHER_STOP_ID, otherStopTitle, stopId, validateSkeleton } from './skeleton.js';
export { validateSection } from './section.js';
export type { SectionContext } from './section.js';
export type { RouteStrings } from './strings.js';
export { routeStrings } from './strings.js';
export { applyFilling } from './types.js';
export type { AcceptedSkeleton, RouteStopFilling, RouteValidation } from './types.js';
