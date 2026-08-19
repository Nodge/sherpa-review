/**
 * The access token arrives in the URL fragment (rpc-design §8). The fragment is not sent to the server,
 * stays out of logs and survives a page reload, so it is not cleared here.
 */
export function readToken(hash: string): string | null {
    const token = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash).get('token');
    return token === null || token === '' ? null : token;
}
