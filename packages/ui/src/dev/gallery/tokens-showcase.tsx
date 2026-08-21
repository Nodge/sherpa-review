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

const GROUPS = parseGroups(tokensCss);

function isPaint(value: string): boolean {
    return value.startsWith('#') || value.startsWith('rgba(') || value.includes('gradient(');
}

export function TokenSwatches() {
    return (
        <div className="showcase">
            {GROUPS.map((group) => (
                <section key={group.title} className="showcase__group">
                    <h3 className="showcase__group-title">{group.title}</h3>
                    <div className="showcase__grid">
                        {group.tokens.map((token) => (
                            <div key={token.name} className="swatch">
                                {isPaint(token.value) ? (
                                    <span className="swatch__paint" style={{ background: `var(${token.name})` }} />
                                ) : (
                                    <span className="swatch__paint swatch__paint--empty" />
                                )}
                                <span className="swatch__name">{token.name}</span>
                                <span className="swatch__value">{token.value}</span>
                            </div>
                        ))}
                    </div>
                </section>
            ))}
        </div>
    );
}

/** A line for visual font checks: Cyrillic (written as escapes), Latin, digits, and machine data symbols. */
const SAMPLE = '\u0428\u0435\u0440\u043f\u0430 · \u043c\u0430\u0440\u0448\u0440\u0443\u0442 — Sherpa route 0123456789 {} => #!';

const SIZE_TOKENS = GROUPS.flatMap((group) => group.tokens).filter((token) =>
    token.name.startsWith('--font-size-'),
);

export function TypographyScale() {
    return (
        <div className="showcase">
            <section className="showcase__group">
                <h3 className="showcase__group-title">IBM Plex Sans</h3>
                {SIZE_TOKENS.map((token) => (
                    <p
                        key={token.name}
                        className="sample sample--sans"
                        style={{ fontSize: `var(${token.name})` }}
                    >
                        <span className="sample__label">
                            {token.name} · {token.value}
                        </span>
                        {SAMPLE}
                    </p>
                ))}
            </section>

            <section className="showcase__group">
                <h3 className="showcase__group-title">IBM Plex Mono</h3>
                {SIZE_TOKENS.map((token) => (
                    <p
                        key={token.name}
                        className="sample sample--mono"
                        style={{ fontSize: `var(${token.name})` }}
                    >
                        <span className="sample__label">
                            {token.name} · {token.value}
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
