/**
 * PR iterations (M4): pure line carryover arithmetic between iterations, without a database or host.
 * Used by progress carryover, stop classification and banner text.
 */
export { affectedStops, buildIterationMap, classifyStop, identityMap } from './line-map.js';
export type { FileStatus, IterationMap, IterationMapInput, MappedRange, StopChangeKind } from './line-map.js';
