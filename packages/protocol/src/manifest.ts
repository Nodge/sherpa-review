import { z } from 'zod';

import { semverSchema } from './version.js';

/**
 * PR key of the form `<host>-<pr>`: manifest and state directory name under `~/.sherpa/prs/`.
 * The alphabet is restricted because the key goes into paths. Otherwise a write could escape `~/.sherpa`.
 * Both sides validate it: the server before creating state, the CLI before reading the manifest.
 */
export const prKeySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
export type PrKey = z.infer<typeof prKeySchema>;

/**
 * Discovery manifest: `~/.sherpa/servers/<prKey>.json`, file permissions 0600 (`docs/protocol.md §8`).
 * The CLI resolves the PR from cwd or `SHERPA_PR` → manifest → port + token. The agent knows neither.
 * A stale manifest (dead PID) is cleaned up on the next skill run.
 */
export const serverManifestSchema = z.object({
    prKey: prKeySchema,
    port: z.number().int().min(1).max(65535),
    pid: z.number().int().positive(),
    token: z.string().min(1),
    protocolVersion: semverSchema,
    serverVersion: semverSchema,
    createdAt: z.iso.datetime(),
});
export type ServerManifest = z.infer<typeof serverManifestSchema>;
