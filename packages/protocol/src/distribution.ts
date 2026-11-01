import { z } from 'zod';

import { semverSchema } from './version.js';

/** `whatsNew` phrase limit: the toast shows two truncated lines. */
export const DISTRIBUTION_WHATS_NEW_MAX_CHARS = 140;

/**
 * Distribution version as an update channel reports the latest published one. The server compares it with
 * the embedded version. Everything but `version` is nullable: a channel may not know it.
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
