/**
 * GitHub pending review body as a set of paragraphs for PR comment drafts (`docs/decisions.md`,
 * "Host adapters", 2026-09-21). GitHub has no PR comment drafts of its own. The review body is
 * the only place that exists before submission, so paragraphs use a marker line
 * `<!-- sherpa:draft <n> -->` (GitHub does not render HTML comments).
 *
 * The marker gives a paragraph a stable number. Removing a neighbor does not renumber the others, and its comment id
 * survives editing and publication. The functions are pure and hold no state.
 */

const MARKER = /^<!--\s*sherpa:draft\s+(\d+)\s*-->$/;

const SEPARATOR = '\n\n';

/**
 * A review body without any paragraphs. The body cannot be empty, since GitHub refuses to edit
 * a bodyless review ("Could not edit a review with a missing body"), making it impossible to append
 * a draft. A placeholder-only body produces no paragraphs and is not exposed externally.
 * The placeholder is not written alongside paragraphs, so within text it is an ordinary line.
 */
export const BODY_PLACEHOLDER = '<!-- sherpa:body -->';

export interface ReviewParagraph {
    /** Paragraph number, monotonic within a review and never reused after deletion. */
    readonly n: number;
    readonly body: string;
}

export interface ReviewBody {
    /** The body has Sherpa markers. `false` means it was written on the GitHub website. */
    readonly marked: boolean;
    readonly paragraphs: readonly ReviewParagraph[];
}

/**
 * Parses a review body. A body without markers is paragraph 0 for both editing and display,
 * and gets a marker on its first rewrite.
 */
export function parseReviewBody(body: string): ReviewBody {
    if (body.trim() === BODY_PLACEHOLDER) {
        // Recognize the placeholder only as the entire body. It is never written alongside paragraphs, and removing
        // the same line from reviewer text would silently lose that text on the first rewrite.
        return { marked: false, paragraphs: [] };
    }

    const lines = body.split('\n');
    const paragraphs: ReviewParagraph[] = [];
    let marked = false;
    let current: { n: number; lines: string[] } | null = null;
    const leading: string[] = [];

    for (const line of lines) {
        const found = MARKER.exec(line.trim());
        if (found?.[1] === undefined) {
            (current?.lines ?? leading).push(line);
            continue;
        }

        marked = true;
        if (current !== null) {
            paragraphs.push({ n: current.n, body: current.lines.join('\n').trim() });
        }
        current = { n: Number(found[1]), lines: [] };
    }
    if (current !== null) {
        paragraphs.push({ n: current.n, body: current.lines.join('\n').trim() });
    }

    const head = leading.join('\n').trim();
    if (head !== '') {
        // Text before the first marker (or the entire body without markers) is paragraph 0.
        paragraphs.unshift({ n: 0, body: head });
    }
    return { marked, paragraphs: paragraphs.filter((paragraph) => paragraph.body !== '') };
}

/** Renders paragraphs as markers and text, separated by blank lines. No paragraphs means a placeholder. */
export function renderReviewBody(paragraphs: readonly ReviewParagraph[]): string {
    if (paragraphs.length === 0) {
        return BODY_PLACEHOLDER;
    }
    return paragraphs.map((paragraph) => `<!-- sherpa:draft ${String(paragraph.n)} -->\n${paragraph.body}`).join(SEPARATOR);
}

/** Appends a paragraph numbered `maximum + 1` to avoid collisions with deleted paragraphs. */
export function appendParagraph(body: string, text: string): { body: string; n: number } {
    const { paragraphs } = parseReviewBody(body);
    const n = paragraphs.reduce((max, paragraph) => Math.max(max, paragraph.n), 0) + 1;
    return { body: renderReviewBody([...paragraphs, { n, body: text }]), n };
}

/** Rewrites a paragraph. null means the number is absent from the body. */
export function replaceParagraph(body: string, n: number, text: string): string | null {
    const { paragraphs } = parseReviewBody(body);
    if (!paragraphs.some((paragraph) => paragraph.n === n)) {
        return null;
    }
    return renderReviewBody(
        paragraphs.map((paragraph) => (paragraph.n === n ? { n, body: text } : paragraph)),
    );
}

/** Removes a paragraph. null means the number is absent. Leaves a placeholder after removing the last one. */
export function removeParagraph(body: string, n: number): string | null {
    const { paragraphs } = parseReviewBody(body);
    if (!paragraphs.some((paragraph) => paragraph.n === n)) {
        return null;
    }
    return renderReviewBody(paragraphs.filter((paragraph) => paragraph.n !== n));
}
