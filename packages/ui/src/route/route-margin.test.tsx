import { fixtureData } from '@sherpa/fixtures';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { DiffFileModel } from '../diff/model.js';
import { toParseRequest } from '../diff/model.js';
import { parseFileDiff } from '../diff/parse.js';
import type { AnchorSpan } from './anchor-clip.js';
import type { RouteMarginFile } from './margin-model.js';
import { RouteBadge, useMarginStrips } from './route-margin.tsx';

/** Route margin markup: both badge variants and hatching, including graceful fallback. */

const DATA = fixtureData('medium');

function modelOf(path: string): DiffFileModel {
    const file = DATA.diff.files.find((candidate) => candidate.path === path);
    if (file === undefined) {
        throw new Error(`fixture has no file ${path}`);
    }
    return parseFileDiff(toParseRequest(file));
}

function marginFile(patch: Partial<RouteMarginFile> = {}): RouteMarginFile {
    return {
        fileId: 'f1',
        stops: [{ stopId: 's02', planLabel: '02', title: 'cache resets after a write' }],
        uncovered: [],
        uncoveredLines: 0,
        parsed: true,
        changed: true,
        ...patch,
    };
}

function Strips({
    model,
    rowsShown,
    ranges,
    line,
}: {
    model: DiffFileModel | null;
    rowsShown: boolean;
    ranges: readonly AnchorSpan[];
    line: { side: 'old' | 'new'; number: number };
}) {
    const strips = useMarginStrips({ model, rowsShown, ranges });
    return (
        <>
            {strips.underHeader}
            {strips.renderAfterLine(line.side, line.number)}
        </>
    );
}

describe('route margin markup', () => {
    it('renders the card badge as a button with an accessible destination label', () => {
        const html = renderToStaticMarkup(
            <RouteBadge file={marginFile()} otherStopId="other" variant="card" onJump={() => undefined} />,
        );

        expect(html).toContain('<button');
        expect(html).toContain('explained in 02 · cache resets after a write');
        expect(html).toContain('aria-label="Explained in stop 02 · cache resets after a write — go there"');
        expect(html).not.toContain('route-badge--hatched');
    });

    it('keeps the badge as a label without a navigation handler', () => {
        const html = renderToStaticMarkup(
            <RouteBadge file={marginFile()} otherStopId="other" variant="tree" />,
        );

        expect(html).not.toContain('<button');
        expect(html).toContain('<span class="route-badge route-badge--tree"');
        expect(html).toContain('>02<');
    });

    it('tree hatching uses text and background and links to Other', () => {
        const html = renderToStaticMarkup(
            <RouteBadge
                file={marginFile({ stops: [] })}
                otherStopId="other"
                variant="tree"
                onJump={() => undefined}
            />,
        );

        expect(html).toContain('route-badge--hatched');
        expect(html).toContain('>outside the route<');
        expect(html).toContain('tabindex="-1"');
    });

    it('gives no badge at all to a file without changed lines', () => {
        expect(
            renderToStaticMarkup(
                <RouteBadge
                    file={marginFile({ stops: [], changed: false })}
                    otherStopId="other"
                    variant="card"
                    onJump={() => undefined}
                />,
            ),
        ).toBe('');
    });

    it('places the strip below the last line of the range', () => {
        const model = modelOf('services/orders/src/payments/generated/psp-schema.ts');
        const range = firstChangedLine(model);
        const html = renderToStaticMarkup(
            <Strips
                model={model}
                rowsShown
                ranges={[{ side: range.side, start: range.line, end: range.line }]}
                line={{ side: range.side, number: range.line }}
            />,
        );

        expect(html).toContain('route-strip');
        expect(html).toContain(`line ${String(range.line)} has no route stop`);
    });

    it('combines ranges into one summary when their lines are not on screen', () => {
        const model = modelOf('services/orders/src/payments/generated/psp-schema.ts');
        const html = renderToStaticMarkup(
            <Strips
                model={model}
                rowsShown={false}
                ranges={[
                    { side: 'new', start: 18, end: 26 },
                    { side: 'old', start: 4, end: 4 },
                ]}
                line={{ side: 'new', number: 26 }}
            />,
        );

        expect(html).toContain('10 lines have no route stop');
        expect(count(html, 'route-strip"')).toBe(1);
    });
});

function firstChangedLine(model: DiffFileModel): { side: 'old' | 'new'; line: number } {
    if (model.content.kind !== 'text') {
        throw new Error('a text patch is required');
    }
    for (const block of model.content.blocks) {
        if (block.kind !== 'hunk') {
            continue;
        }
        for (const line of block.lines) {
            if (line.kind === 'add' && line.newLine !== null) {
                return { side: 'new', line: line.newLine };
            }
            if (line.kind === 'del' && line.oldLine !== null) {
                return { side: 'old', line: line.oldLine };
            }
        }
    }
    throw new Error('patch has no changed lines');
}

function count(html: string, needle: string): number {
    return html.split(needle).length - 1;
}
