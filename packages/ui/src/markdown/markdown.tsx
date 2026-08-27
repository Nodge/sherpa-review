import type { ReactNode } from 'react';
import { Fragment } from 'react';

import type { InlineNode, MarkdownBlock, MarkdownList, MarkdownProfile } from './markdown.js';
import { parseBlocks, parseInline } from './markdown.js';
import './markdown.css';

/**
 * Render markdown as React elements. `dangerouslySetInnerHTML` is never allowed here:
 * build elements from parsed nodes, with raw source HTML arriving as text.
 *
 * The `comment` profile returns blocks (paragraphs, headings, lists, code) and must go
 * in a container. The `route` profile returns only inline nodes. The caller keeps the line element (`h2`, `p`, `li`),
 * so route card layout does not change.
 */
export function Markdown({ text, profile }: { text: string; profile: MarkdownProfile }) {
    if (profile === 'route') {
        return <>{inlineNodes(parseInline(text, 'route'))}</>;
    }
    return <>{parseBlocks(text).map(renderBlock)}</>;
}

function renderBlock(block: MarkdownBlock, index: number): ReactNode {
    switch (block.kind) {
        case 'heading':
            // A heading is a bold line at the same font size, not h1–h6. Cards are narrow,
            // and a separate type scale inside other people's text breaks the rhythm (SPEC-additions §1e).
            return (
                <p key={index} className="md-heading">
                    {inlineNodes(block.children)}
                </p>
            );
        case 'code':
            return (
                <pre key={index} className="md-pre">
                    <code>{block.text}</code>
                </pre>
            );
        case 'list':
            return <ListBlock key={index} list={block.list} />;
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

function ListBlock({ list }: { list: MarkdownList }) {
    const items = list.items.map((item, index) => (
        <li key={index} className="md-item">
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
