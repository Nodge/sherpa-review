import type { CSSProperties, ReactNode } from 'react';
import { Fragment } from 'react';

import type { LanguageId, SyntaxToken } from '../diff/model.js';
import { highlightText, languageByName } from '../diff/syntax.js';

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

export function renderBlock(block: MarkdownBlock, index: number): ReactNode {
    switch (block.kind) {
        case 'heading': {
            // Real h1–h6: the level carries structure, while font size uses the three steps
            // of the handoff scale. Separate typography inside external text breaks the card rhythm.
            const Tag = HEADING_TAGS[block.level];
            return (
                <Tag key={index} data-source-line={block.source?.start} className={`md-heading ${headingClass(block.level)}`}>
                    {inlineNodes(block.children)}
                </Tag>
            );
        }
        case 'code': {
            // Unrecognised language: keep the fence as text, with the info string still visible in `data-lang`.
            const language = block.lang === null ? null : languageByName(block.lang);
            return (
                <pre key={index} className="md-pre" data-lang={block.lang ?? undefined}>
                    <code>{block.source === undefined ? (language === null ? block.text : highlighted(block.text, language)) : block.text.split('\n').map((line, i) => <Fragment key={i}>{i === 0 ? null : '\n'}<span data-source-line={block.source === undefined ? undefined : block.source.start + i + 1}>{language === null ? line : highlighted(line, language)}</span></Fragment>)}</code>
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
                            <tr data-source-line={block.source?.start}>
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
                                    <tr key={rowIndex} data-source-line={block.source === undefined ? undefined : block.source.start + rowIndex + 2}>
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
                            {block.source === undefined ? inlineNodes(line) : <span data-source-line={block.source.start + lineIndex}>{inlineNodes(line)}</span>}
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
 * Highlight fence contents with the same engine as the diff. A fence is a complete code fragment,
 * so highlight it in one call rather than line by line.
 */
function highlighted(text: string, language: LanguageId): ReactNode[] {
    const tokens = highlightText(text, language);
    return text.split('\n').map((line, index) => (
        <Fragment key={index}>
            {index === 0 ? null : '\n'}
            {lineTokens(line, tokens[index] ?? [])}
        </Fragment>
    ));
}

function lineTokens(line: string, tokens: readonly SyntaxToken[]): ReactNode[] {
    const nodes: ReactNode[] = [];
    let at = 0;

    for (const token of tokens) {
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
            {item.sourceLine === undefined ? inlineNodes(item.children) : <span data-source-line={item.sourceLine}>{inlineNodes(item.children)}</span>}
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
