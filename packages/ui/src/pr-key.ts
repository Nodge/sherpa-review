/**
 * A PR key is `<host>-<pr>` (see the protocol's `prKeySchema`). Until actual PR metadata arrives
 * (M1-T10), it supplies the breadcrumb. The host and number are all the UI knows about the PR.
 */
export function breadcrumbFromPrKey(prKey: string): readonly string[] {
    const separator = prKey.indexOf('-');
    if (separator <= 0 || separator === prKey.length - 1) {
        return [prKey];
    }
    return [prKey.slice(0, separator), `PR ${prKey.slice(separator + 1)}`];
}
