/**
 * Address bar state lives in the URL fragment in `URLSearchParams` format:
 * `#token=<token>&view=route`. The fragment stays out of server requests and logs and survives
 * reloads, so it holds both the access token (rpc-design §8) and what should return
 * after F5: the active view, later the filter (SPEC §2.7) and other view parameters.
 *
 * Parsing is shared. Later tasks add parameters without changing the mechanism.
 */

export function parseFragment(hash: string): URLSearchParams {
    return new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
}

/** `null` means the parameter is missing or empty. An empty string is not a value. */
export function readFragmentParam(hash: string, name: string): string | null {
    const value = parseFragment(hash).get(name);
    return value === null || value === '' ? null : value;
}

export function readToken(hash: string): string | null {
    return readFragmentParam(hash, 'token');
}

/**
 * A new fragment with the edit applied: a `null` value removes the parameter.
 * The order of other parameters is preserved, so the token stays first.
 */
export function updateFragment(hash: string, patch: Readonly<Record<string, string | null>>): string {
    const params = parseFragment(hash);
    for (const [name, value] of Object.entries(patch)) {
        if (value === null) {
            params.delete(name);
        } else {
            params.set(name, value);
        }
    }

    const next = params.toString();
    return next === '' ? '' : `#${next}`;
}
