import type {
    HeadingLevel,
    InlineNode,
    MarkdownBlock,
    MarkdownList,
    MarkdownSource,
    TableAlign,
} from '@sherpa/protocol/markdown';
import { parseBlocks, parseInline, parseStopBlocks } from '@sherpa/protocol/markdown';
import type { CSSProperties, ReactNode } from 'react';
import { Fragment } from 'react';

import type { LanguageId, SyntaxToken } from '../diff/model.js';
import { highlightText, languageByName } from '../diff/syntax.js';

import './markdown.css';

/**
 * Render markdown as React elements. `dangerouslySetInnerHTML` is never allowed here:
 * build elements from parsed nodes, with raw source HTML arriving as text.
 *
 * The `comment` profile returns blocks (paragraphs, headings, blockquotes, tables, lists, code), so insert
 * it into a container. The `route` profile returns inline nodes only: the caller owns the line element (`h2`, `p`,
 * `li`), so route card layout stays unchanged.
 * `StopMarkdown` renders the stop description (`stop`), which also needs a navigation handler.
 */
export function Markdown({ text, profile }: { text: string; profile: 'comment' | 'route' }) {
    if (profile === 'route') {
        return <>{inlineNodes(parseInline(text, 'route'))}</>;
    }
    return <>{parseBlocks(text).map((block, index) => renderBlock(block, index))}</>;
}

/** Internal navigation from a stop description to a plan stop or diff file. */
export type StopLink =
    | { readonly kind: 'stop'; readonly planIndex: number }
    | { readonly kind: 'file'; readonly path: string };

/**
 * Stop description: the vocabulary blocks in §2 of the 09-20 spec are paragraphs and a flat list. Place it in a
 * container, just like the comment profile.
 *
 * External links open a new tab. `onOpenLink` intercepts internal links (`#stop-N`, `#file-<path>`)
 * for the same navigation as stop file chips. Without a handler, an internal
 * link goes nowhere: the view cannot navigate by URL.
 */
export function StopMarkdown({ text, onOpenLink }: { text: string; onOpenLink?: (link: StopLink) => void }) {
    const link: LinkRenderer = (node, key) => {
        const target = stopLinkOf(node.href);
        if (target === null) {
            // External links leave the reader, so open a new tab without a referrer.
            return (
                <a key={key} className="md-link" href={node.href} target="_blank" rel="noopener noreferrer">
                    {inlineNodes(node.children)}
                </a>
            );
        }
        return (
            <a
                key={key}
                className="md-link"
                href={node.href}
                onClick={(event) => {
                    event.preventDefault();
                    onOpenLink?.(target);
                }}
            >
                {inlineNodes(node.children)}
            </a>
        );
    };
    return <>{parseStopBlocks(text).map((block, index) => renderBlock(block, index, link))}</>;
}

/** Internal navigation target. `null` means the link is external. */
export function stopLinkOf(href: string): StopLink | null {
    const stop = /^#stop-(\d+)$/.exec(href);
    if (stop !== null) {
        return { kind: 'stop', planIndex: Number(stop[1]) };
    }
    const file = /^#file-(\S+)$/.exec(href);
    return file === null ? null : { kind: 'file', path: file[1] ?? '' };
}

const HEADING_TAGS = { 1: 'h1', 2: 'h2', 3: 'h3', 4: 'h4', 5: 'h5', 6: 'h6' } as const;

/** Link rendering: the view intercepts internal targets in a stop description. */
type LinkRenderer = (node: Extract<InlineNode, { kind: 'link' }>, key: number) => ReactNode;

export function renderBlock(block: MarkdownBlock, index: number, link?: LinkRenderer): ReactNode {
    switch (block.kind) {
        case 'heading': {
            // Real h1–h6: the level carries structure, while font size uses the three steps
            // of the handoff scale. Separate typography inside external text breaks the card rhythm.
            const Tag = HEADING_TAGS[block.level];
            return (
                <Tag
                    key={index}
                    data-source-line={block.source?.start}
                    className={`md-heading ${headingClass(block.level)}`}
                >
                    {inlineNodes(block.children, link)}
                </Tag>
            );
        }
        case 'code': {
            // Unrecognised language: keep the fence as text, with the info string still visible in `data-lang`.
            const language = block.lang === null ? null : languageByName(block.lang);
            return (
                <pre key={index} className="md-pre" data-lang={block.lang ?? undefined}>
                    <code>{codeLines(block, language)}</code>
                </pre>
            );
        }
        case 'list':
            return <ListBlock key={index} list={block.list} link={link} />;
        case 'quote':
            return (
                <blockquote key={index} className="md-quote">
                    {block.children.map((child, childIndex) => renderBlock(child, childIndex, link))}
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
                                        {inlineNodes(cell, link)}
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        {block.rows.length === 0 ? null : (
                            <tbody>
                                {block.rows.map((row, rowIndex) => (
                                    <tr key={rowIndex} data-source-line={sourceLine(block.source, rowIndex + 2)}>
                                        {row.map((cell, cellIndex) => (
                                            <td key={cellIndex} style={alignStyle(block.align[cellIndex] ?? null)}>
                                                {inlineNodes(cell, link)}
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
                            {withSourceLine(sourceLine(block.source, lineIndex), inlineNodes(line, link))}
                        </Fragment>
                    ))}
                </p>
            );
    }
}

/** Source line number offset from the block start. A block without a range is outside the diff document. */
function sourceLine(source: MarkdownSource | undefined, offset: number): number | undefined {
    return source === undefined ? undefined : source.start + offset;
}

/** Wrapper with a line number used to find the diff line from a document selection. */
function withSourceLine(line: number | undefined, children: ReactNode): ReactNode {
    return line === undefined ? children : <span data-source-line={line}>{children}</span>;
}

/**
 * Mark up a fence with a source range line by line: each line needs its own number, so
 * highlight each line separately too. Without a range, highlight the whole body.
 */
function codeLines(block: Extract<MarkdownBlock, { kind: 'code' }>, language: LanguageId | null): ReactNode {
    if (block.source === undefined) {
        return language === null ? block.text : highlighted(block.text, language);
    }
    // The opening fence takes the line before the body.
    const first = block.fenced ? 1 : 0;
    return block.text.split('\n').map((line, index) => (
        <Fragment key={index}>
            {index === 0 ? null : '\n'}
            {withSourceLine(
                sourceLine(block.source, index + first),
                language === null ? line : highlighted(line, language),
            )}
        </Fragment>
    ));
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

function ListBlock({ list, link }: { list: MarkdownList; link: LinkRenderer | undefined }) {
    const items = list.items.map((item, index) => (
        <li key={index} className={item.check === null ? 'md-item' : 'md-item md-item--task'}>
            {item.check === null ? null : (
                <span className={item.check ? 'md-check md-check--on' : 'md-check'} aria-hidden="true" />
            )}
            {withSourceLine(item.sourceLine, inlineNodes(item.children, link))}
            {item.list === null ? null : <ListBlock list={item.list} link={link} />}
        </li>
    ));
    return list.ordered ? <ol className="md-list">{items}</ol> : <ul className="md-list">{items}</ul>;
}

function inlineNodes(nodes: readonly InlineNode[], link?: LinkRenderer): ReactNode[] {
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
                return (
                    <strong key={index} className="md-strong">
                        {inlineNodes(node.children, link)}
                    </strong>
                );
            case 'em':
                return <em key={index}>{inlineNodes(node.children, link)}</em>;
            case 'strike':
                return <del key={index}>{inlineNodes(node.children, link)}</del>;
            case 'link':
                if (link !== undefined) {
                    return link(node, index);
                }
                // External links leave the reader, so open a new tab without a referrer.
                return (
                    <a key={index} className="md-link" href={node.href} target="_blank" rel="noreferrer">
                        {inlineNodes(node.children)}
                    </a>
                );
        }
    });
}
