import { z } from 'zod';

import { semverSchema } from './version.js';

/** `whatsNew` phrase limit: the toast shows two truncated lines. */
export const DISTRIBUTION_WHATS_NEW_MAX_CHARS = 140;

/**
 * Distribution `version.json`: build and release version. The update channel returns the latest
 * published version in the same format, and the server compares it with the embedded one. The build writes `version` and `builtFrom`,
 * and the release command adds `releasedAt` and `whatsNew`. Release fields are nullable: before release, `dist/` has the same file without them.
 */
export const distributionVersionSchema = z.object({
    version: semverSchema,
    /** Source revision id used for the build. null means unknown. */
    builtFrom: z.string().nullable(),
    releasedAt: z.iso.datetime().nullable(),
    /** One "what is new" phrase for the update toast, not a changelog. */
    whatsNew: z.string().max(DISTRIBUTION_WHATS_NEW_MAX_CHARS).nullable(),
});
export type DistributionVersion = z.infer<typeof distributionVersionSchema>;
