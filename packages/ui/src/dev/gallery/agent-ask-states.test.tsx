import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AGENT_ASK_DIFF_STATES, AGENT_ASK_ROUTE_STATES } from './agent-ask-states.tsx';

describe('Ask AI entry point gallery', () => {
    it('renders the Other entry point in both agent states', () => {
        expect(AGENT_ASK_ROUTE_STATES.map((state) => state.id)).toEqual(['route-other-ask', 'route-other-ask-offline']);

        const [connected, offline] = AGENT_ASK_ROUTE_STATES.map((state) => renderToStaticMarkup(<>{state.render()}</>));
        expect(connected).toContain('Ask the agent to place them');
        expect(connected).toContain('the answer lands in the chat, the route does not change');
        expect(connected).not.toContain('Reconnect the agent');
        expect(offline).toContain('Reconnect the agent to ask about these lines');
        expect(offline).toContain('disabled');
    });

    it('renders the strip with a button, an asked chip and a disabled button', () => {
        expect(AGENT_ASK_DIFF_STATES.map((state) => state.id)).toEqual([
            'full-diff-strip-ask',
            'full-diff-strip-asked',
            'full-diff-strip-offline',
        ]);

        const [ask, asked, offline] = AGENT_ASK_DIFF_STATES.map((state) => renderToStaticMarkup(<>{state.render()}</>));
        expect(ask).toContain('Ask the agent to place them');
        expect(ask).not.toContain('disabled');
        expect(asked).toContain('asked · the answer will land here');
        expect(asked).not.toContain('<button');
        expect(offline).toContain('Reconnect the agent to ask about these lines');
        expect(offline).toContain('disabled');
    });
});
