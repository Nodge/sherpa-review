import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ViewedToggle } from './viewed-toggle.tsx';

/**
 * "Viewed" mark is one control for a file and a stop (docs/design/SPEC-elements.md §2.10): two states,
 * identical text and box in both places, and each call site adds only its own class.
 */

function render(props: Partial<Parameters<typeof ViewedToggle>[0]> = {}): string {
    return renderToStaticMarkup(
        <ViewedToggle
            className={props.className ?? 'route-stop__viewed'}
            viewed={props.viewed ?? false}
            {...(props.disabled === undefined ? {} : { disabled: props.disabled })}
            {...(props.title === undefined ? {} : { title: props.title })}
            onToggle={props.onToggle ?? (() => undefined)}
        />,
    );
}

describe('viewed mark', () => {
    it('unviewed: empty box and an invitation to mark viewed', () => {
        const html = render();

        expect(html).toContain('aria-pressed="false"');
        expect(html).toContain('Mark viewed');
        expect(html).toContain('viewed-toggle__box');
        expect(html).not.toContain('is-viewed');
    });

    it('viewed: filled box, label without a glyph in the text', () => {
        const html = render({ viewed: true });

        expect(html).toContain('aria-pressed="true"');
        expect(html).toContain('is-viewed');
        expect(html).toContain('data-icon="check"');
        expect(html).toContain('width="9"');
        expect(html).toContain('</span>Viewed</button>');
    });

    it('both places use the same control: markup differs only by the location class', () => {
        const stop = render({ className: 'route-stop__viewed', viewed: true });
        const file = render({ className: 'file-card__viewed', viewed: true });

        expect(file).toBe(stop.replace('route-stop__viewed', 'file-card__viewed'));
    });

    it('disabled toggle always explains why (docs/design/SPEC-elements.md §1.1)', () => {
        const html = render({ disabled: true, title: 'Stop ranges are still being calculated' });

        expect(html).toContain('disabled=""');
        expect(html).toContain('title="Stop ranges are still being calculated"');
    });
});
