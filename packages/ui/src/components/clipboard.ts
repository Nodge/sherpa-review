/**
 * One function for clipboard copying. `navigator.clipboard` is not always available (it is absent in insecure
 * contexts), and writes fail when the tab loses focus or the reviewer
 * denies permission. Both cases show a helpful message instead of throwing an exception.
 */

export type CopyOutcome = 'copied' | 'failed' | 'unavailable';

export async function copyText(text: string): Promise<CopyOutcome> {
    const clipboard = (navigator as unknown as { readonly clipboard?: Pick<Clipboard, 'writeText'> }).clipboard;
    if (clipboard === undefined) {
        return 'unavailable';
    }
    try {
        await clipboard.writeText(text);
        return 'copied';
    } catch {
        return 'failed';
    }
}
