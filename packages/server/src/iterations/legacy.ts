/**
 * Unknown iteration: M3 chat anchors, progress written before M4, and a server without a host adapter
 * (it has no source of iterations). The server treats these records as belonging to the active iteration:
 * `IterationFeed` adopts them as soon as the host identifies the active one.
 */
export const LEGACY_DIFF_ID = 'unknown';
