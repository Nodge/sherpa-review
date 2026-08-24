import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { agentPillView } from './agent-pill-view.js';
import { AgentPill } from './top-bar.tsx';

describe('agent pill popover', () => {
    it('opens the reconnect command for never with the disconnected tone', () => {
        const html = renderToStaticMarkup(
            <AgentPill
                view={agentPillView({ kind: 'never' }, [])}
                reconnectCommand="/sherpa fixture-medium"
                defaultOpen
            />,
        );

        expect(html).toContain('Connect the agent');
        expect(html).toContain('/sherpa fixture-medium');
        expect(html).not.toContain('Agent chat will appear here in M3.');
    });
});
