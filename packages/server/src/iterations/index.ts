/**
 * PR iterations: pure arithmetic for carrying lines over between iterations. No database or host.
 * Used by progress carryover, stop classification and banner text.
 */
export { LEGACY_DIFF_ID } from './legacy.js';
export { affectedStops, buildIterationMap, classifyStop, identityMap, opaqueMap } from './line-map.js';
export type { FileStatus, IterationMap, IterationMapInput, MappedRange, StopChangeKind } from './line-map.js';
