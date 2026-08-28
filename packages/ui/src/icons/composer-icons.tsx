import type { CSSProperties } from 'react';

export type ComposerIconName =
    | 'ic-bold'
    | 'ic-italic'
    | 'ic-link'
    | 'ic-code'
    | 'ic-codeblock'
    | 'ic-list'
    | 'ic-trash'
    | 'ic-pencil'
    | 'ic-check'
    | 'ic-cross';

const SYMBOLS = `<symbol id="ic-bold" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3h3.6a2.5 2.5 0 0 1 0 5H5zM5 8h4.2a2.5 2.5 0 0 1 0 5H5z"></path></symbol>
<symbol id="ic-italic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M6.4 3h4.8M4.8 13h4.8M9.6 3 7 13"></path></symbol>
<symbol id="ic-link" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6.6 9.4 9.4 6.6M6.9 4.6l1.4-1.4a2.7 2.7 0 0 1 3.8 3.8l-1.4 1.4M9.1 11.4l-1.4 1.4a2.7 2.7 0 0 1-3.8-3.8l1.4-1.4"></path></symbol>
<symbol id="ic-code" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4.2 2.6 8 6 11.8M10 4.2 13.4 8 10 11.8"></path></symbol>
<symbol id="ic-codeblock" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><rect x="2.2" y="3.2" width="11.6" height="9.6" rx="1.6"></rect><path d="M6.4 6.6 4.8 8l1.6 1.4M9.6 6.6 11.2 8 9.6 9.4"></path></symbol>
<symbol id="ic-list" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M6 4.4h7.6M6 8h7.6M6 11.6h7.6"></path><circle cx="3" cy="4.4" r="1"></circle><circle cx="3" cy="8" r="1"></circle><circle cx="3" cy="11.6" r="1"></circle></symbol>
<symbol id="ic-trash" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"><path d="M3.2 4.6h9.6M6.4 4.6V3.2h3.2v1.4M4.6 4.6l.6 8.2h5.6l.6-8.2"></path></symbol>
<symbol id="ic-pencil" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3.2 12.8l.55-2.45 6.9-6.9 1.9 1.9-6.9 6.9z"></path><path d="M9.4 4.8l1.9 1.9"></path></symbol>
<symbol id="ic-check" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3.4 8.5 6.4 11.5 12.8 5.1"></path></symbol>
<symbol id="ic-cross" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4.5 4.5 11.5 11.5M11.5 4.5 4.5 11.5"></path></symbol>`;

/** Temporary branch F sprite. IDs match the M2F-T15 sprite. */
export function ComposerIconSprite() {
    return (
        <svg
            aria-hidden="true"
            width="0"
            height="0"
            style={{ position: 'absolute', overflow: 'hidden' }}
            dangerouslySetInnerHTML={{ __html: SYMBOLS }}
        />
    );
}

export function ComposerIcon({
    name,
    size,
    className,
}: {
    name: ComposerIconName;
    size: 9 | 13 | 14 | 15;
    className?: string;
}) {
    const style: CSSProperties = { display: 'block', flex: 'none' };
    return (
        <svg
            className={className}
            width={size}
            height={size}
            viewBox="0 0 16 16"
            style={style}
            aria-hidden="true"
        >
            <use href={`#${name}`} />
        </svg>
    );
}
