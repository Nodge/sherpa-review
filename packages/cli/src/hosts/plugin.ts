import type { CommandRunner } from '../command.js';

/**
 * CLI host plugin: what the CLI knows about a host to identify a PR by key. The CLI core doesn't know
 * hosts by name. The plugin list comes from the composition root (`hosts/all.ts`) through the entry point.
 * All capabilities are optional. A plugin supplies only what its host supports.
 */
export interface CliHostPlugin {
    readonly name: string;
    /**
     * PR link or number → key. null means the input doesn't belong to this host. Receives any explicit
     * `--pr`/`SHERPA_PR` value, including ready-made keys for any host. Return null for those.
     */
    normalizeKey?(input: string): string | null;
    /** Current branch PR in the launch directory. */
    readonly discoverPr?: PrDiscoverer;
    /** Checkout of this VCS for local review. */
    readonly detectLocal?: LocalDetector;
}

export type PrDiscovery =
    | { readonly kind: 'found'; readonly prKey: string }
    /** One-line reason for the user hint, with no trailing period. */
    | { readonly kind: 'unavailable'; readonly hint: string };

export interface PrDiscoverer {
    /** No step crashes the CLI. Any failure returns `unavailable` with a one-line reason. */
    discover(run: CommandRunner): Promise<PrDiscovery>;
    /** How the user can make discovery work. The end of the hint: "…, or <suggestion>.". */
    readonly suggestion: string;
}

/** VCS answer about a directory: its branch for the key if a checkout is found, otherwise a reason. */
export type LocalDetection =
    | { readonly kind: 'found'; readonly branch: string }
    /** Why this is not a checkout of this VCS, as a rejection line, for example "hg: <stderr>". */
    | { readonly kind: 'absent'; readonly reason: string };

export interface LocalDetector {
    /** VCS kind: part of the `local-<vcs>-…` key and the binary name in hints. */
    readonly vcs: string;
    /** How the server computes the base without `--base`, as wording for the `up` output line. */
    readonly defaultBase: string;
    /**
     * The directory is itself the checkout root for this VCS (its marker is directly inside it). This takes priority over
     * list order, as a nested repository is closer to the directory than the enclosing checkout.
     */
    ownsDirectory?(dir: string): Promise<boolean>;
    /** Whether the directory is in this VCS checkout and on which branch. Checkout found but branch unreadable means `CliError`. */
    detect(dir: string, run: CommandRunner): Promise<LocalDetection>;
}
