import { describe, expect, it } from 'vitest';

import { DEFAULT_LISTEN_HOST, readListenHost, uiHostForListenHost } from './listen-host.js';

describe('server address', () => {
    it('keeps IPv4 loopback for an empty or whitespace-only address', () => {
        for (const raw of [undefined, '', '   ']) {
            expect(readListenHost({ SHERPA_LISTEN_HOST: raw })).toBe(DEFAULT_LISTEN_HOST);
        }
    });

    it('preserves an explicit address and uses the machine hostname in the URL for an external listener', () => {
        expect(readListenHost({ SHERPA_LISTEN_HOST: ' :: ' })).toBe('::');
        expect(uiHostForListenHost('::', 'sherpa-vm.example')).toBe('sherpa-vm.example');
        expect(uiHostForListenHost('127.0.0.1', 'sherpa-vm.example')).toBe('127.0.0.1');
        expect(uiHostForListenHost('::1', 'sherpa-vm.example')).toBe('::1');
    });
});
