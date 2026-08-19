declare const __SHERPA_VERSION__: string | undefined;

/** CLI version: esbuild inserts it at build time, otherwise a placeholder. */
export const CLI_VERSION = typeof __SHERPA_VERSION__ === 'string' ? __SHERPA_VERSION__ : '0.0.0-dev';
