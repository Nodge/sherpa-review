declare const __SHERPA_VERSION__: string | undefined;

/**
 * CLI version: esbuild replaces it at build time. Outside a build (tests, tsx), it is zero:
 * the contract accepts only `X.Y.Z`, and a suffix such as `-dev` would fail request validation.
 */
export const CLI_VERSION = typeof __SHERPA_VERSION__ === 'string' ? __SHERPA_VERSION__ : '0.0.0';
