/**
 * Random UUID in one function: `crypto.randomUUID` is only available in a secure context, and over
 * HTTP on a VM hostname (`SHERPA_LISTEN_HOST=::`) it does not exist. A direct call would throw
 * an exception. `crypto.getRandomValues` is available there too, so the fallback builds UUID v4 itself.
 */

export function newUuid(): string {
    const randomUUID = (crypto as unknown as { readonly randomUUID?: () => string }).randomUUID;
    if (randomUUID !== undefined) {
        return randomUUID.call(crypto);
    }

    const hex = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte, index) =>
        withFixedBits(byte, index).toString(16).padStart(2, '0'),
    ).join('');
    return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

/** Byte 6 holds the version number in its high nibble, byte 8 holds the RFC 4122 variant. The rest are random. */
function withFixedBits(byte: number, index: number): number {
    if (index === 6) {
        return (byte & 0x0f) | 0x40;
    }
    if (index === 8) {
        return (byte & 0x3f) | 0x80;
    }
    return byte;
}
