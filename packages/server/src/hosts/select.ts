import type { HostPlugin, SelectedHost, SelectHostOptions } from './plugin.js';

/**
 * Selects a host adapter by PR key (`<host>-<pr>`, `docs/protocol.md §8`), using the first plugin
 * whose prefix matches the start of the key. If its `make` returns null or no prefix matches, there is no host,
 * and review endpoints respond with `no_review_host`.
 */
export function selectReviewHost(
    prKey: string,
    options: SelectHostOptions,
    hosts: readonly HostPlugin[],
): SelectedHost | null {
    const plugin = pluginFor(prKey, hosts);
    const made = plugin?.make(prKey, options) ?? null;
    return plugin === null || made === null ? null : { ...made, name: plugin.name, ui: plugin.ui };
}

/** The plugin explanation for a key without a host, for the log. null means there is nothing to explain. */
export function unconfiguredHostReason(
    prKey: string,
    options: SelectHostOptions,
    hosts: readonly HostPlugin[],
): string | null {
    return pluginFor(prKey, hosts)?.unconfigured?.(prKey, options) ?? null;
}

function pluginFor(prKey: string, hosts: readonly HostPlugin[]): HostPlugin | null {
    return hosts.find((plugin) => prKey.startsWith(plugin.keyPrefix)) ?? null;
}
