/**
 * Check for a new version in main (M5, planning decision 7). Only the injection point exists here for now.
 * `UpdateChecker` is task M5-T9.
 */
export interface UpdateCheckOptions {
    /** Distribution directory realpath from `--install-dir`. undefined means a dev run without a distribution. */
    readonly installDir?: string;
    /** Transport. Defaults to global fetch. */
    readonly fetch?: typeof fetch;
    readonly now?: () => Date;
    /** Result cache file. Defaults to `<sherpaDir>/update-check.json`. */
    readonly cacheFile?: string;
    /** Distribution path in main. Defaults to `tools/sherpa`. */
    readonly distributionPath?: string;
}
