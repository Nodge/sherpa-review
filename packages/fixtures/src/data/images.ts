/**
 * Images for the `medium` fixture. The PNG is 48×32 RGBA with a transparent background and a coloured
 * rectangle. A zlib/struct script generated the bytes (compression 9), stored in the repository
 * as base64, the only form that lets binary data survive in TS source.
 * The SVG is built from its own text: the same line array also goes into the file-addition patch.
 */

/** PNG edit: the rectangle moved and changed colour, visible both by eye and pixel by pixel. */
export const PNG_BEFORE_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAADAAAAAgCAYAAABU1PscAAAANElEQVR42u3PAQkAMAgAQQOacGW1hAyFO/gAHwGwUr6qyQwYMGDAgAEDBgwYMHBnAAD4oAGZs50uQz8MsgAAAABJRU5ErkJggg==';
export const PNG_AFTER_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAADAAAAAgCAYAAABU1PscAAAAM0lEQVR42u3PQQkAAAgAMQOazNIaQj/CBhfgIgCAx7qyLzNgwIABAwYMGDBgwMCfAYCVASMKiS40cqcGAAAAAElFTkSuQmCC';

/**
 * Small 24×16 PNG: absent from `medium`, needed only by the state gallery
 * to show Diff mode with sides of different sizes.
 */
export const PNG_SMALL_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAABgAAAAQCAYAAAAMJL+VAAAAIElEQVR42mNgGAWkAqWjh/6Tg0ctGLVg1AISLBgFdAcAy6JOwBEFpxUAAAAASUVORK5CYII=';

/** Deleted PNG: only one side, and the file has no `after` at all. */
export const PNG_DELETED_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAADAAAAAgCAYAAABU1PscAAAAOklEQVR42u3PUQkAMAhAQaMvgPms474NIAx2D16Ai5A0yjr98gAAAAAAAAAAAAAAAAAAAAAAOwDpsy6QMcxX9xvYOgAAAABJRU5ErkJggg==';

/** Added SVG: it has both an image and a normal text patch built from these same lines. */
export const SVG_LINES: readonly string[] = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">',
    '  <title>Edit window countdown</title>',
    '  <circle cx="24" cy="24" r="20" fill="none" stroke="#4c9aff" stroke-width="4" />',
    '  <path d="M24 12 v12 h9" fill="none" stroke="#4c9aff" stroke-width="4"',
    '        stroke-linecap="round" stroke-linejoin="round" />',
    '</svg>',
];

/** Whole file: lines joined with `\n` and a trailing newline, as in the repository. */
export const SVG_TEXT = `${SVG_LINES.join('\n')}\n`;

/** The content is ASCII, so `btoa` works in both the browser and Node. */
export const SVG_BASE64 = btoa(SVG_TEXT);
