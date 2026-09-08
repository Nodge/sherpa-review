import { z } from 'zod';

import { semverSchema } from './version.js';

/** `whatsNew` phrase limit: the toast shows two truncated lines. */
export const DISTRIBUTION_WHATS_NEW_MAX_CHARS = 140;

/**
 * Distribution `version.json`: the source of truth for checking
 * whether a new version is available. The build (`build.mjs`) writes `version` and `builtFrom`. The release command
 * adds `releasedAt` and `whatsNew`. The server reads the file from main and compares it with the embedded version.
 * Release fields are nullable: `dist/` before release has the same file without them.
 */
export const distributionVersionSchema = z.object({
    version: semverSchema,
    /** Build source identifier: short HEAD hash, `-dirty` for uncommitted changes. null means no git. */
    builtFrom: z.string().nullable(),
    releasedAt: z.iso.datetime().nullable(),
    /** One "what is new" phrase for the update toast, not a changelog. */
    whatsNew: z.string().max(DISTRIBUTION_WHATS_NEW_MAX_CHARS).nullable(),
});
export type DistributionVersion = z.infer<typeof distributionVersionSchema>;
