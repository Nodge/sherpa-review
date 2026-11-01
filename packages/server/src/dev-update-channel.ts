import type { UpdateChannel } from './update-channel.js';

/**
 * Update channel of the dev server (`dev.ts`) for a distribution without its own channel: it knows no versions and
 * makes no requests. The `update-available` dev endpoint needs it, as the gallery and e2e show the update toast
 * with it, and without a channel the server builds no update hint. The hint is only the install directory.
 */
export const DEV_UPDATE_CHANNEL: UpdateChannel = {
    id: 'dev',
    latest: () => Promise.resolve(null),
    install: (installDir) => ({ dir: installDir, command: null, readmeUrl: null }),
};
