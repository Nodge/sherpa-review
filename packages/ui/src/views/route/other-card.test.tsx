// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RegenerateBanner } from './other-card.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: (() => void)[] = [];

afterEach(() => {
    for (const unmount of mounted.splice(0)) {
        unmount();
    }
});

describe('insufficiently explained route banner', () => {
    it('keeps the advice without a dead button when generation is unavailable', () => {
        const host = document.createElement('div');
        document.body.append(host);
        const root = createRoot(host);
        act(() => {
            root.render(<RegenerateBanner />);
        });
        mounted.push(() => {
            act(() => {
                root.unmount();
            });
            host.remove();
        });

        expect(host.textContent).toContain('consider regenerating');
        expect(host.querySelector('button')).toBeNull();
    });

    it('offers an enabled regeneration button that calls the same entry point', () => {
        const host = document.createElement('div');
        document.body.append(host);
        const onGenerate = vi.fn();
        const root = createRoot(host);
        act(() => {
            root.render(<RegenerateBanner onGenerate={onGenerate} />);
        });
        mounted.push(() => {
            act(() => {
                root.unmount();
            });
            host.remove();
        });

        const button = host.querySelector('button');
        expect(button?.textContent).toBe('Regenerate');
        expect(button?.getAttribute('type')).toBe('button');
        act(() => {
            button?.click();
        });
        expect(onGenerate).toHaveBeenCalledOnce();
    });
});
