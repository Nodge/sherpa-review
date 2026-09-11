/**
 * Listening socket address from `SHERPA_LISTEN_HOST` and the machine hostname for the UI URL.
 * By default, only the machine itself can reach the server. An external listener is enabled through the entry point's
 * environment (docs/protocol.md §8).
 */

/** Local loopback remains the safe default when the server address is not configured. */
export const DEFAULT_LISTEN_HOST = '127.0.0.1';

/** Listening socket address from the entry point's environment. Whitespace counts as an absent setting. */
export function readListenHost(env: NodeJS.ProcessEnv): string {
    const host = env.SHERPA_LISTEN_HOST?.trim();
    return host === undefined || host === '' ? DEFAULT_LISTEN_HOST : host;
}

/** An external listener uses the machine hostname in the UI URL. Loopback keeps the exact address. */
export function uiHostForListenHost(listenHost: string, machineHost: string): string {
    return ['127.0.0.1', '::1', 'localhost'].includes(listenHost) ? listenHost : machineHost;
}
