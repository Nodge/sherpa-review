import { describe, expect, it } from 'vitest';

import { reconnectCommand } from './reconnect-command.js';

describe('worker connection command', () => {
    it('uses only prKey', () => {
        expect(reconnectCommand('github-quillmart--quillmart--9005')).toBe('/sherpa github-quillmart--quillmart--9005');
        expect(reconnectCommand('fixture-medium')).toBe('/sherpa fixture-medium');
    });
});
