declare const __SHERPA_VERSION__: string | undefined;

/**
 * Distribution version in the top bar, injected by vite at build time from the UI `package.json`
 * (the same approach as the CLI). Zero outside a build.
 */
export const UI_VERSION = typeof __SHERPA_VERSION__ === 'string' ? __SHERPA_VERSION__ : '0.0.0';
