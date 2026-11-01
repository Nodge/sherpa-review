declare const __SHERPA_VERSION__: string | undefined;

/**
 * Distribution version in the top bar: vite injects it at build time from `packages/npm/package.json`
 * (the same approach as the CLI and server). Zero outside a build.
 */
export const UI_VERSION = typeof __SHERPA_VERSION__ === 'string' ? __SHERPA_VERSION__ : '0.0.0';
