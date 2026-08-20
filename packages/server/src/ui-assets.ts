/**
 * UI asset map embedded in the server bundle: build path → base64 file contents.
 *
 * Intentionally empty in the source. `build-server.mjs` supplies the real contents
 * (an esbuild plugin replaces this entire module after reading `packages/ui/dist`), so dev runs
 * under tsx serve UI from disk, and the bundle serves it from memory. Only `bundle.ts` needs to import this module.
 */
export const UI_ASSETS: Readonly<Record<string, string>> = {};
