// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';

import type { AvatarProps } from './avatar.tsx';
import { Avatar, initials, pairInitials } from './avatar.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PHOTO = 'https://avatars.githubusercontent.com/alice?s=100';
const mounted: (() => void)[] = [];

afterEach(() => {
    for (const unmount of mounted.splice(0)) {
        unmount();
    }
});

function mount(
    url: string | null,
    props: Partial<AvatarProps> = {},
): { host: HTMLElement; rerender: (next: string | null) => void } {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const render = (next: string | null) => {
        act(() => {
            root.render(<Avatar className="thread__avatar" name="Alice Ingram" {...props} url={next} />);
        });
    };
    render(url);
    mounted.push(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
    });
    return { host, rerender: render };
}

function fail(host: HTMLElement): void {
    const img = host.querySelector('img');
    if (img === null) {
        throw new Error('photo not rendered');
    }
    act(() => {
        img.dispatchEvent(new Event('error'));
    });
}

describe('avatar', () => {
    it('shows only initials in the caller box when there is no URL', () => {
        const html = renderToStaticMarkup(<Avatar className="thread__avatar" name="Alice Ingram" url={null} />);

        expect(html).toBe('<span class="avatar thread__avatar" aria-hidden="true">AI</span>');
    });

    it('places a decorative lazy-loaded photo over the initials when there is a URL', () => {
        const { host } = mount(PHOTO);
        const img = host.querySelector('img');

        expect(host.textContent).toBe('AI');
        expect(img?.getAttribute('src')).toBe(PHOTO);
        expect(img?.getAttribute('alt')).toBe('');
        expect(img?.getAttribute('loading')).toBe('lazy');
        expect(img?.getAttribute('decoding')).toBe('async');
        expect(img?.getAttribute('referrerpolicy')).toBe('no-referrer');
    });

    it('keeps the initials after a photo load failure and does not request the same URL again', () => {
        const { host, rerender } = mount(PHOTO);
        fail(host);

        expect(host.querySelector('img')).toBeNull();
        expect(host.textContent).toBe('AI');

        rerender(PHOTO);
        expect(host.querySelector('img')).toBeNull();

        const other = 'https://avatars.githubusercontent.com/bob?s=100';
        rerender(other);
        expect(host.querySelector('img')?.getAttribute('src')).toBe(other);

        fail(host);
        rerender(PHOTO);
        expect(host.querySelector('img')).toBeNull();
        expect(host.textContent).toBe('AI');
    });

    it('uses two letters for a single-word login in the PR header, both without a photo and after an error', () => {
        expect(
            renderToStaticMarkup(
                <Avatar className="pr-header__avatar" name="alice" url={null} initialsRule="pair" />,
            ),
        ).toBe('<span class="avatar pr-header__avatar" aria-hidden="true">NO</span>');

        const { host } = mount(PHOTO, { name: 'alice', initialsRule: 'pair' });
        fail(host);
        expect(host.textContent).toBe('NO');

        const thread = mount(null, { name: 'alice' });
        expect(thread.host.textContent).toBe('N');
    });

    it('takes initials from the first two words of the name or login', () => {
        expect(initials('Alice Ingram')).toBe('AI');
        expect(initials('lint-bot')).toBe('LB');
        expect(initials('a.vance')).toBe('AV');
        expect(initials('alice')).toBe('A');
    });

    it('takes the first two letters of a single word for header initials', () => {
        expect(pairInitials('alice')).toBe('AL');
        expect(pairInitials('Alice Ingram')).toBe('AI');
        expect(pairInitials('a.vance')).toBe('AV');
    });
});
