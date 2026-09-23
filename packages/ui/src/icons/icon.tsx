import sprite from './sprite.svg?raw';
import './icons.css';

export type IconName =
    | 'search'
    | 'chev-down'
    | 'chev-right'
    | 'thumb'
    | 'pencil'
    | 'check'
    | 'cross'
    | 'swap'
    | 'arrow-up'
    | 'arrow-down'
    | 'updown'
    | 'reply'
    | 'bold'
    | 'italic'
    | 'link'
    | 'code'
    | 'codeblock'
    | 'list'
    | 'trash'
    /** Settings menu trigger. Additions has no such icon, so the geometry comes from the prototype. */
    | 'sliders'
    /** Open-issue dot in the Resolve button. Its drawing comes from the iteration 09-20 prototype. */
    | 'dot';

export type IconSize = 9 | 11 | 13 | 14 | 15;

export interface IconProps {
    readonly name: IconName;
    readonly size: IconSize;
    readonly className?: string;
}

/** Icon from the embedded SVG sprite. Both attributes and a non-shrinking flex item set its size. */
export function Icon({ name, size, className }: IconProps) {
    return (
        <svg
            className={`icon${className === undefined ? '' : ` ${className}`}`}
            width={size}
            height={size}
            viewBox="0 0 16 16"
            aria-hidden="true"
            focusable="false"
            data-icon={name}
        >
            <use href={`#ic-${name}`} />
        </svg>
    );
}

/**
 * One embedded sprite per document. Nineteen symbols come verbatim from Sherpa Additions,
 * `ic-sliders` comes from the Sherpa.dc.html prototype, `ic-dot` from the iteration 09-20 prototype.
 */
export function IconSprite() {
    return <div className="icon-sprite" aria-hidden="true" dangerouslySetInnerHTML={{ __html: sprite }} />;
}
