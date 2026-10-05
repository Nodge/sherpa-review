import { useEffect, useRef, useState } from 'react';

import { type ResolvedTheme, useResolvedTheme } from '../../settings/document-settings.tsx';
import tokensCss from '../../styles/tokens.css?raw';

/**
 * Token display: swatches and the typography scale come from `tokens.css` itself, instead of
 * a second list that would eventually drift from the system.
 */

interface TokenGroup {
    readonly title: string;
    readonly tokens: readonly { readonly name: string; readonly value: string }[];
}

/** Groups come from comment headings like "--- Name ---" inside `:root`. */
function parseGroups(css: string): readonly TokenGroup[] {
    const groups: { title: string; tokens: { name: string; value: string }[] }[] = [];
    let current: { title: string; tokens: { name: string; value: string }[] } | null = null;

    for (const line of css.split('\n')) {
        const heading = /^\s*\/\*\s*---\s*(.+?)\s*---/.exec(line)?.[1];
        if (heading !== undefined) {
            current = { title: heading, tokens: [] };
            groups.push(current);
            continue;
        }

        const [, name, value] = /^\s*(--[a-z0-9-]+)\s*:\s*([^;]+);/.exec(line) ?? [];
        if (name !== undefined && value !== undefined && current !== null) {
            current.tokens.push({ name, value: value.trim() });
        }
    }

    return groups;
}

const BASE_RULE = /:root(?:\s*,\s*\[data-theme\])?\s*\{([^}]*)\}/.exec(tokensCss)?.[1] ?? '';
const GROUPS = parseGroups(BASE_RULE);
const BASE_VALUES = new Map(GROUPS.flatMap((group) => group.tokens.map((token) => [token.name, token.value])));
const THEME_VALUES: Readonly<Record<ResolvedTheme, ReadonlyMap<string, string>>> = {
    dark: themeValues('dark'),
    light: themeValues('light'),
    
    
};

/** Applies all rules for the selected theme in order, including blocks shared by both colour palettes. */
function themeValues(theme: ResolvedTheme): ReadonlyMap<string, string> {
    const values = new Map<string, string>();
    const selector = new RegExp(`^(?::root)?\\[data-theme=['"]${theme}['"]\\]$`);
    const css = tokensCss.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const [, selectors, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (!selectors?.split(',').some((candidate) => selector.test(candidate.trim()))) {
            continue;
        }
        for (const match of (body ?? '').matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
            if (match[1] !== undefined && match[2] !== undefined) {
                values.set(match[1], match[2].trim());
            }
        }
    }
    return values;
}

function tokenValue(theme: ResolvedTheme, name: string): string {
    return THEME_VALUES[theme].get(name) ?? BASE_VALUES.get(name) ?? '';
}

function isPaint(value: string): boolean {
    return value.startsWith('#') || value.startsWith('rgba(') || value.includes('gradient(');
}

export function TokenSwatches() {
    const theme = useResolvedTheme();
    return (
        <div className="showcase">
            {GROUPS.map((group) => (
                <section key={group.title} className="showcase__group">
                    <h3 className="showcase__group-title">{group.title}</h3>
                    <div className="showcase__grid">
                        {group.tokens.map((token) => {
                            const value = tokenValue(theme, token.name);
                            return (
                                <div key={token.name} className="swatch">
                                    {isPaint(value) ? (
                                        <span className="swatch__paint" style={{ background: `var(${token.name})` }} />
                                    ) : (
                                        <span className="swatch__paint swatch__paint--empty" />
                                    )}
                                    <span className="swatch__name">{token.name}</span>
                                    <span className="swatch__value">{value}</span>
                                </div>
                            );
                        })}
                    </div>
                </section>
            ))}
        </div>
    );
}

/**
 * Responsive widths (docs/design/SPEC-theming-2026-09-12.md §6): values depend on the window,
 * so the display shows what the browser resolves them to right now, instead of the declaration.
 * The "at 2560: tree 560, agent panel 560, limit 1280/1920" acceptance check is visible as numbers. The narrative
 * column is absent here: its `26%` is based on view content, and outside the route the number would be wrong.
 */
const WIDTH_SAMPLES: readonly { readonly label: string; readonly value: string }[] = [
    { label: 'view side margin', value: 'var(--space-page)' },
    { label: 'narrative ↔ diff gap', value: 'var(--space-column)' },
    { label: 'Full diff file tree', value: 'var(--width-file-tree)' },
    { label: 'agent panel', value: 'var(--width-agent-panel)' },
];

function WidthBar({ label, value }: { label: string; value: string }) {
    const [measured, setMeasured] = useState<number | null>(null);
    const ref = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        const element = ref.current;
        if (element === null) {
            return;
        }
        const report = (): void => {
            setMeasured(Math.round(element.getBoundingClientRect().width));
        };
        report();
        const observer = new ResizeObserver(report);
        observer.observe(element);
        return () => {
            observer.disconnect();
        };
    }, []);

    return (
        <div className="width-sample">
            <span className="width-sample__label">{label}</span>
            <div className="width-sample__track">
                <div className="width-sample__bar" ref={ref} style={{ width: value }} />
            </div>
            <span className="width-sample__value">
                {value} → {measured === null ? '—' : `${String(measured)}px`}
            </span>
        </div>
    );
}

/** Layout widths and code panel limit by diff mode. */
export function LayoutWidths() {
    return (
        <div className="showcase">
            <section className="showcase__group">
                <h3 className="showcase__group-title">Layout widths</h3>
                {WIDTH_SAMPLES.map((sample) => (
                    <WidthBar key={sample.label} label={sample.label} value={sample.value} />
                ))}
            </section>

            <section className="showcase__group">
                <h3 className="showcase__group-title">Code panel limit</h3>
                {/* The view sets the same attribute on its root: switching modes changes the limit. */}
                <div data-diff-mode="unified">
                    <WidthBar label="unified" value="var(--diff-max)" />
                </div>
                <div data-diff-mode="split">
                    <WidthBar label="side by side" value="var(--diff-max)" />
                </div>
            </section>
        </div>
    );
}

/** A line for visual font checks: Cyrillic (written as escapes), Latin, digits, and machine data symbols. */
const SAMPLE = '\u0428\u0435\u0440\u043f\u0430 · \u043c\u0430\u0440\u0448\u0440\u0443\u0442 — Sherpa route 0123456789 {} => #!';

const SIZE_TOKENS = GROUPS.flatMap((group) => group.tokens).filter((token) =>
    token.name.startsWith('--font-size-'),
);

export function TypographyScale() {
    const theme = useResolvedTheme();
    return (
        <div className="showcase">
            <section className="showcase__group">
                <h3 className="showcase__group-title">{tokenValue(theme, '--font-sans')}</h3>
                {SIZE_TOKENS.map((token) => (
                    <p
                        key={token.name}
                        className="sample sample--sans"
                        style={{ fontSize: `var(${token.name})` }}
                    >
                        <span className="sample__label">
                            {token.name} · {tokenValue(theme, token.name)}
                        </span>
                        {SAMPLE}
                    </p>
                ))}
            </section>

            <section className="showcase__group">
                <h3 className="showcase__group-title">{tokenValue(theme, '--font-mono')}</h3>
                {SIZE_TOKENS.map((token) => (
                    <p
                        key={token.name}
                        className="sample sample--mono"
                        style={{ fontSize: `var(${token.name})` }}
                    >
                        <span className="sample__label">
                            {token.name} · {tokenValue(theme, token.name)}
                        </span>
                        {SAMPLE}
                    </p>
                ))}
            </section>

            <section className="showcase__group">
                <h3 className="showcase__group-title">Font styles</h3>
                <p className="sample sample--sans" style={{ fontWeight: 400 }}>
                    Sans 400 · {SAMPLE}
                </p>
                <p className="sample sample--sans" style={{ fontWeight: 450 }}>
                    Sans 450 (Text) · {SAMPLE}
                </p>
                <p className="sample sample--sans" style={{ fontWeight: 500 }}>
                    Sans 500 · {SAMPLE}
                </p>
                <p className="sample sample--sans" style={{ fontWeight: 600 }}>
                    Sans 600 · {SAMPLE}
                </p>
                <p className="sample sample--sans" style={{ fontStyle: 'italic' }}>
                    Sans 400 italic · {SAMPLE}
                </p>
                <p className="sample sample--sans" style={{ fontStyle: 'italic', fontWeight: 450 }}>
                    Sans 450 italic · {SAMPLE}
                </p>
                <p className="sample sample--mono" style={{ fontWeight: 400 }}>
                    Mono 400 · {SAMPLE}
                </p>
                <p className="sample sample--mono" style={{ fontWeight: 500 }}>
                    Mono 500 · {SAMPLE}
                </p>
                <p className="sample sample--mono" style={{ fontStyle: 'italic' }}>
                    Mono 400 italic · {SAMPLE}
                </p>
            </section>
        </div>
    );
}
