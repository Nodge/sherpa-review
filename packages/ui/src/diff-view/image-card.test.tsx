// @vitest-environment jsdom
import { fixtureIteration } from '@sherpa/fixtures';
import type { FileDiff, FileImage } from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BlobLoader } from './blob-loader.tsx';
import { ImageBody } from './image-card.tsx';

/**
 * Image card: mode availability for each side, object URL lifetime and failure
 * behavior. A stub supplies the bytes through an injected transport, so neither a server nor
 * a fixture host is needed here.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DATA = fixtureIteration('medium');

function imageFile(suffix: string): { file: FileDiff; image: FileImage } {
    const file = DATA.diff.files.find((candidate) => candidate.path.endsWith(suffix));
    if (file?.image == null) {
        throw new Error(`medium fixture needs an image ${suffix}`);
    }
    return { file, image: file.image };
}

const MODIFIED = imageFile('edit-window-banner.png');
const ADDED = imageFile('countdown-icon.svg');
const DELETED = imageFile('legacy-window-badge.png');

let created: string[] = [];
let revoked: string[] = [];

beforeEach(() => {
    created = [];
    revoked = [];
    URL.createObjectURL = vi.fn(() => {
        const url = `blob:mock/${String(created.length)}`;
        created.push(url);
        return url;
    });
    URL.revokeObjectURL = vi.fn((url: string) => {
        revoked.push(url);
    });
});

const mounted: (() => void)[] = [];

afterEach(() => {
    for (const unmount of mounted.splice(0)) {
        unmount();
    }
});

function render(node: ReactNode): { host: HTMLElement; unmount: () => void } {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
        root.render(node);
    });
    const unmount = (): void => {
        act(() => {
            root.unmount();
        });
        host.remove();
    };
    mounted.push(unmount);
    return { host, unmount };
}

/** Transport that returns bytes, with a call counter to track how often it is called. */
function okLoader(): BlobLoader & { calls: string[] } {
    const calls: string[] = [];
    const loader = (blobId: string): Promise<Blob | null> => {
        calls.push(blobId);
        return Promise.resolve(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }));
    };
    return Object.assign(loader, { calls });
}

/** jsdom does not load images. Set natural dimensions by hand and dispatch a `load` event. */
function measure(image: HTMLImageElement | undefined, width: number, height: number): void {
    if (image === undefined) {
        throw new Error('image layer missing');
    }
    Object.defineProperty(image, 'naturalWidth', { value: width, configurable: true });
    Object.defineProperty(image, 'naturalHeight', { value: height, configurable: true });
    act(() => {
        image.dispatchEvent(new Event('load'));
    });
}

async function settle(): Promise<void> {
    await act(async () => {
        await Promise.resolve();
    });
}

function modes(host: HTMLElement): HTMLButtonElement[] {
    return [...host.querySelectorAll<HTMLButtonElement>('.image-card__modes .image-card__mode')];
}

function mode(host: HTMLElement, label: string): HTMLButtonElement {
    const found = modes(host).find((button) => button.textContent === label);
    if (found === undefined) {
        throw new Error(`mode button missing: ${label}`);
    }
    return found;
}

describe('image card', () => {
    it('offers overlays for a file with two sides, but not for a one-sided file', async () => {
        const both = render(<ImageBody file={MODIFIED.file} image={MODIFIED.image} loadBlob={okLoader()} />);
        const single = render(<ImageBody file={DELETED.file} image={DELETED.image} loadBlob={okLoader()} />);
        await settle();

        expect(mode(both.host, 'Swipe').disabled).toBe(false);
        expect(mode(both.host, 'Onion Skin').disabled).toBe(false);
        expect(mode(single.host, 'Swipe').disabled).toBe(true);
        expect(mode(single.host, 'Swipe').title).toBe('both sides are needed');
        // `Diff` is disabled in both cards: the mode arrives in T25.
        expect(mode(both.host, 'Diff').disabled).toBe(true);
        expect(mode(both.host, 'Diff').title).toBe('попиксельная разница появится позже');
    });

    it('offers Text only for an image with a text patch', async () => {
        const svg = render(
            <ImageBody file={ADDED.file} image={ADDED.image} loadBlob={okLoader()} textBody={<p>lines</p>} />,
        );
        const png = render(<ImageBody file={MODIFIED.file} image={MODIFIED.image} loadBlob={okLoader()} />);
        await settle();

        expect(modes(svg.host).map((button) => button.textContent)).toContain('Text');
        expect(modes(png.host).map((button) => button.textContent)).not.toContain('Text');

        act(() => {
            mode(svg.host, 'Text').click();
        });
        expect(svg.host.textContent).toContain('lines');
    });

    it('creates an object URL for each side and releases it on unmount', async () => {
        const view = render(<ImageBody file={MODIFIED.file} image={MODIFIED.image} loadBlob={okLoader()} />);
        await settle();

        expect(created).toHaveLength(2);
        expect(view.host.querySelectorAll('img.image-card__image')).toHaveLength(2);

        view.unmount();
        expect(revoked).toEqual(created);
    });

    it('downloads the object URL under the file name', async () => {
        const { host } = render(<ImageBody file={MODIFIED.file} image={MODIFIED.image} loadBlob={okLoader()} />);
        await settle();

        const links = [...host.querySelectorAll<HTMLAnchorElement>('a.image-card__download')];
        expect(links).toHaveLength(2);
        expect(links[0]?.getAttribute('download')).toBe('edit-window-banner.png');
        expect(links[0]?.getAttribute('href')).toBe(created[0]);
    });

    it('does not load a side over the limit and explains its size', async () => {
        const loader = okLoader();
        const image: FileImage = {
            ...MODIFIED.image,
            before: { blobId: 'blob:huge', size: 12_000_000 },
            after: null,
        };
        const { host } = render(<ImageBody file={MODIFIED.file} image={image} loadBlob={loader} />);
        await settle();

        expect(loader.calls).toEqual([]);
        expect(host.textContent).toContain('too large: 11.4 MB');
    });

    it('shows the missing-on-host message for a host 404, without a retry button', async () => {
        const { host } = render(
            <ImageBody file={DELETED.file} image={DELETED.image} loadBlob={() => Promise.resolve(null)} />,
        );
        await settle();

        expect(host.textContent).toContain('нет у хоста');
        expect(host.querySelector('.image-card__retry')).toBeNull();
    });

    it('shows the reason for an endpoint failure and calls the transport again on Retry', async () => {
        const calls: string[] = [];
        let fail = true;
        const loader: BlobLoader = (blobId) => {
            calls.push(blobId);
            return fail ? Promise.reject(new Error('endpoint answered 500')) : Promise.resolve(new Blob([]));
        };
        const { host } = render(<ImageBody file={DELETED.file} image={DELETED.image} loadBlob={loader} />);
        await settle();

        expect(calls).toHaveLength(1);
        expect(host.textContent).toContain('failed to load: endpoint answered 500');

        fail = false;
        act(() => {
            host.querySelector<HTMLButtonElement>('.image-card__retry')?.click();
        });
        await settle();

        expect(calls).toHaveLength(2);
        expect(host.querySelector('img.image-card__image')).not.toBeNull();
    });

    it('moves the Swipe divider by keyboard: ←/→ by 2 %, Home and End to the edges', async () => {
        const { host } = render(
            <ImageBody file={MODIFIED.file} image={MODIFIED.image} loadBlob={okLoader()} initial={{ mode: 'swipe' }} />,
        );
        await settle();

        const divider = host.querySelector<HTMLElement>('.image-card__divider');
        if (divider === null) {
            throw new Error('divider missing');
        }
        expect(divider.getAttribute('aria-valuenow')).toBe('50');

        const press = (key: string): void => {
            act(() => {
                divider.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
            });
        };

        press('ArrowLeft');
        expect(divider.getAttribute('aria-valuenow')).toBe('48');
        press('ArrowRight');
        press('ArrowRight');
        expect(divider.getAttribute('aria-valuenow')).toBe('52');
        press('Home');
        expect(divider.getAttribute('aria-valuenow')).toBe('0');
        press('End');
        expect(divider.getAttribute('aria-valuenow')).toBe('100');
    });

    it('sets the Onion Skin top side opacity from the slider', async () => {
        const { host } = render(
            <ImageBody file={MODIFIED.file} image={MODIFIED.image} loadBlob={okLoader()} initial={{ mode: 'onion' }} />,
        );
        await settle();

        const clip = host.querySelector<HTMLElement>('.image-card__clip');
        expect(clip?.style.opacity).toBe('0.5');
    });

    it('gives each overlay side its own share of the box instead of stretching it to fill', async () => {
        const { host } = render(
            <ImageBody file={MODIFIED.file} image={MODIFIED.image} loadBlob={okLoader()} initial={{ mode: 'onion' }} />,
        );
        await settle();

        const layers = [...host.querySelectorAll<HTMLImageElement>('.image-card__layer')];
        measure(layers[0], 48, 32);
        measure(layers[1], 96, 64);

        expect(layers[0]?.style.width).toBe('50%');
        expect(layers[1]?.style.width).toBe('100%');
        // Height follows width. The overlay box can be taller than its aspect ratio, and a percentage
        // height would stretch the image.
        expect(layers[0]?.style.height).toBe('auto');
        expect(layers[1]?.style.height).toBe('auto');
    });

    it('clips the full-box After layer in Swipe instead of the image itself', async () => {
        const { host } = render(
            <ImageBody
                file={MODIFIED.file}
                image={MODIFIED.image}
                loadBlob={okLoader()}
                initial={{ mode: 'swipe', swipe: 35 }}
            />,
        );
        await settle();

        const clip = host.querySelector<HTMLElement>('.image-card__clip');
        expect(clip?.style.clipPath).toBe('inset(0 65% 0 0)');
        expect(clip?.querySelector('.image-card__layer')).not.toBeNull();
    });
});
