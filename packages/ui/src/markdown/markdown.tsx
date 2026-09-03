import type { CSSProperties, ReactNode } from 'react';
import { Fragment } from 'react';

import type { LanguageId } from '../diff/model.js';
import { tokenizeLine } from '../diff/syntax.js';

import type {
    HeadingLevel,
    InlineNode,
    MarkdownBlock,
    MarkdownList,
    MarkdownProfile,
    TableAlign,
} from './markdown.js';
import { parseBlocks, parseInline } from './markdown.js';
import './markdown.css';

/**
 * Render markdown as React elements. `dangerouslySetInnerHTML` is never allowed here:
 * build elements from parsed nodes, with raw source HTML arriving as text.
 *
 * The `comment` profile returns blocks (paragraphs, headings, blockquotes, tables, lists, code), so insert
 * it into a container. The `route` profile returns inline nodes only: the caller owns the line element (`h2`, `p`,
 * `li`), so route card layout stays unchanged.
 */
export function Markdown({ text, profile }: { text: string; profile: MarkdownProfile }) {
    if (profile === 'route') {
        return <>{inlineNodes(parseInline(text, 'route'))}</>;
    }
    return <>{parseBlocks(text).map(renderBlock)}</>;
}

const HEADING_TAGS = { 1: 'h1', 2: 'h2', 3: 'h3', 4: 'h4', 5: 'h5', 6: 'h6' } as const;

/**
 * Fence info string → diff highlighting profile. Keys are the language names used in comments.
 * Values are the only languages the `diff/syntax.ts` lexer knows.
 */
const FENCE_LANGUAGES: Readonly<Record<string, LanguageId>> = {
    ts: 'ts',
    typescript: 'ts',
    tsx: 'ts',
    mts: 'ts',
    cts: 'ts',
    js: 'ts',
    javascript: 'ts',
    jsx: 'ts',
    mjs: 'ts',
    cjs: 'ts',
    py: 'py',
    python: 'py',
    go: 'go',
    golang: 'go',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    css: 'css',
    md: 'md',
    markdown: 'md',
};

function renderBlock(block: MarkdownBlock, index: number): ReactNode {
    switch (block.kind) {
        case 'heading': {
            // Real h1–h6: the level carries structure, while font size uses the three steps
            // of the handoff scale. Separate typography inside external text breaks the card rhythm.
            const Tag = HEADING_TAGS[block.level];
            return (
                <Tag key={index} className={`md-heading ${headingClass(block.level)}`}>
                    {inlineNodes(block.children)}
                </Tag>
            );
        }
        case 'code': {
            const language = block.lang === null ? undefined : FENCE_LANGUAGES[block.lang];
            return (
                <pre key={index} className="md-pre" data-lang={block.lang ?? undefined}>
                    <code>{language === undefined ? block.text : highlighted(block.text, language)}</code>
                </pre>
            );
        }
        case 'list':
            return <ListBlock key={index} list={block.list} />;
        case 'quote':
            return (
                <blockquote key={index} className="md-quote">
                    {block.children.map(renderBlock)}
                </blockquote>
            );
        case 'table':
            return (
                <div key={index} className="md-table-wrap">
                    <table className="md-table">
                        <thead>
                            <tr>
                                {block.head.map((cell, cellIndex) => (
                                    <th key={cellIndex} style={alignStyle(block.align[cellIndex] ?? null)}>
                                        {inlineNodes(cell)}
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        {block.rows.length === 0 ? null : (
                            <tbody>
                                {block.rows.map((row, rowIndex) => (
                                    <tr key={rowIndex}>
                                        {row.map((cell, cellIndex) => (
                                            <td key={cellIndex} style={alignStyle(block.align[cellIndex] ?? null)}>
                                                {inlineNodes(cell)}
                                            </td>
                                        ))}
                                    </tr>
                                ))}
                            </tbody>
                        )}
                    </table>
                </div>
            );
        case 'paragraph':
            return (
                <p key={index} className="md-p">
                    {block.lines.map((line, lineIndex) => (
                        <Fragment key={lineIndex}>
                            {lineIndex === 0 ? null : <br />}
                            {inlineNodes(line)}
                        </Fragment>
                    ))}
                </p>
            );
    }
}

function headingClass(level: HeadingLevel): string {
    return `md-h${String(level)}`;
}

function alignStyle(align: TableAlign): CSSProperties | undefined {
    return align === null ? undefined : { textAlign: align };
}

/**
 * Highlight the fence body with the same lexer as the diff. It keeps no state between lines,
 * so processing one line at a time is exactly what it expects.
 */
function highlighted(text: string, language: LanguageId): ReactNode[] {
    return text.split('\n').map((line, index) => (
        <Fragment key={index}>
            {index === 0 ? null : '\n'}
            {lineTokens(line, language)}
        </Fragment>
    ));
}

function lineTokens(line: string, language: LanguageId): ReactNode[] {
    const nodes: ReactNode[] = [];
    let at = 0;

    for (const token of tokenizeLine(line, language)) {
        if (token.from > at) {
            nodes.push(line.slice(at, token.from));
        }
        nodes.push(
            <span key={token.from} className={`syntax-${token.kind}`}>
                {line.slice(token.from, token.to)}
            </span>,
        );
        at = token.to;
    }

    if (at < line.length) {
        nodes.push(line.slice(at));
    }
    return nodes;
}

function ListBlock({ list }: { list: MarkdownList }) {
    const items = list.items.map((item, index) => (
        <li key={index} className={item.check === null ? 'md-item' : 'md-item md-item--task'}>
            {item.check === null ? null : (
                <span className={item.check ? 'md-check md-check--on' : 'md-check'} aria-hidden="true" />
            )}
            {inlineNodes(item.children)}
            {item.list === null ? null : <ListBlock list={item.list} />}
        </li>
    ));
    return list.ordered ? <ol className="md-list">{items}</ol> : <ul className="md-list">{items}</ul>;
}

function inlineNodes(nodes: readonly InlineNode[]): ReactNode[] {
    return nodes.map((node, index) => {
        switch (node.kind) {
            case 'text':
                return <Fragment key={index}>{node.text}</Fragment>;
            case 'code':
                return (
                    <code key={index} className="md-code">
                        {node.text}
                    </code>
                );
            case 'strong':
                return <strong key={index}>{inlineNodes(node.children)}</strong>;
            case 'em':
                return <em key={index}>{inlineNodes(node.children)}</em>;
            case 'strike':
                return <del key={index}>{inlineNodes(node.children)}</del>;
            case 'link':
                // External links leave the reader, so open a new tab without a referrer.
                return (
                    <a key={index} className="md-link" href={node.href} target="_blank" rel="noreferrer">
                        {inlineNodes(node.children)}
                    </a>
                );
        }
    });
}
