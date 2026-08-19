import { z } from 'zod';

import { semverSchema } from './version.js';

/**
 * Discovery manifest: `~/.sherpa/servers/<prKey>.json`, file permissions 0600 (rpc-design §8).
 * The CLI resolves the PR from cwd or `SHERPA_PR` → manifest → port + token. The agent knows neither.
 * A stale manifest (dead PID) is cleaned up on the next skill run.
 */
export const serverManifestSchema = z.object({
    /** PR key in the form `<host>-<pr>`, also the state directory name in `~/.sherpa/prs/`. */
    prKey: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    pid: z.number().int().positive(),
    token: z.string().min(1),
    protocolVersion: semverSchema,
    serverVersion: semverSchema,
    createdAt: z.iso.datetime(),
});
export type ServerManifest = z.infer<typeof serverManifestSchema>;
