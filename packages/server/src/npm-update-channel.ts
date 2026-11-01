import type { DistributionVersion, UiUpdateInstall } from '@sherpa/protocol';
import { distributionVersionSchema } from '@sherpa/protocol';
import { z } from 'zod';

import type { UpdateChannel, UpdateChannelRequest } from './update-channel.js';

const REGISTRY_BASE = 'https://registry.npmjs.org';
const PACKAGE_PAGE_BASE = 'https://www.npmjs.com/package';

/** Only the `latest` tag and version publication times are needed from the full package document. */
const packumentSchema = z.object({
    'dist-tags': z.object({ latest: z.string() }),
    time: z.record(z.string(), z.string()).optional(),
});

/** npm update channel: the latest version is the package's `latest` tag in the npm registry, and the instructions are its package page. */
export class NpmUpdateChannel implements UpdateChannel {
    readonly id: string;
    private readonly packageName: string;

    constructor(packageName: string) {
        this.packageName = packageName;
        this.id = `npm:${packageName}`;
    }

    /** null means the package is unpublished in the registry (404). */
    async latest({ fetch, signal }: UpdateChannelRequest): Promise<DistributionVersion | null> {
        const response = await fetch(`${REGISTRY_BASE}/${registryPath(this.packageName)}`, {
            headers: { accept: 'application/json' },
            signal,
        });
        if (response.status === 404) {
            return null;
        }
        if (!response.ok) {
            throw new Error(`response ${String(response.status)}`);
        }
        const packument = packumentSchema.parse(await response.json());
        const version = packument['dist-tags'].latest;
        const releasedAt = z.iso.datetime().safeParse(packument.time?.[version]);
        return distributionVersionSchema.parse({
            version,
            builtFrom: null,
            releasedAt: releasedAt.success ? releasedAt.data : null,
            whatsNew: null,
        });
    }

    /** The channel does not know how the package was installed. No command or directory, only the package page. */
    install(): UiUpdateInstall {
        return {
            dir: null,
            command: null,
            readmeUrl: `${PACKAGE_PAGE_BASE}/${this.packageName}`,
        };
    }
}

/** The registry expects the scope slash (`@scope/name`) to be URL-encoded. */
function registryPath(packageName: string): string {
    return packageName.startsWith('@')
        ? `@${encodeURIComponent(packageName.slice(1))}`
        : encodeURIComponent(packageName);
}
