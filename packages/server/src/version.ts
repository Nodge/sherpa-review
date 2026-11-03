declare const __SHERPA_VERSION__: string | undefined;

/**
 * Server version, included in the discovery manifest and `/healthz` response. esbuild injects it
 * from `packages/npm/package.json` when building the server bundle (as with the CLI and UI).
 * Outside a build (tests, `tsx src/dev.ts`) it is zero: the contract accepts only `X.Y.Z`,
 * and the protocol `semverSchema` would reject a suffix like `-dev`.
 */
export const SERVER_VERSION = typeof __SHERPA_VERSION__ === 'string' ? __SHERPA_VERSION__ : '0.0.0';
