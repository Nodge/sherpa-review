/**
 * Patch for a file `git diff` does not show. Untracked files are absent from the working-tree
 * diff, but the reviewer needs them too, so the adapter writes a full-file addition patch itself.
 */

/** How many content bytes to check for a null byte: binary data is detectable at the start of the file. */
const BINARY_PROBE_BYTES = 8 * 1024;

/** Binary file markers in a `git` patch. */
const BINARY_PATCH_MARKER = /^(?:Binary files |GIT binary patch)/mu;

export function isBinaryContent(content: Uint8Array): boolean {
    const limit = Math.min(content.length, BINARY_PROBE_BYTES);
    for (let index = 0; index < limit; index += 1) {
        if (content[index] === 0) {
            return true;
        }
    }
    return false;
}

/** A `git` patch for a binary file contains no text to display. */
export function isBinaryPatch(patch: string): boolean {
    return BINARY_PATCH_MARKER.test(patch);
}

/**
 * Full patch for a new file. null means binary contents: the file gets `patch: null`
 * and `binary: true`.
 */
export function synthesizeAddPatch(path: string, content: Uint8Array): string | null {
    if (isBinaryContent(content)) {
        return null;
    }

    const header = [`diff --git a/${path} b/${path}`, 'new file mode 100644', '--- /dev/null', `+++ b/${path}`];
    if (content.length === 0) {
        // Empty file: no hunk is needed because there is nothing to add, and `@@ -0,0 +1,0 @@` only confuses the parser.
        return `${header.join('\n')}\n`;
    }

    const text = new TextDecoder().decode(content);
    const endsWithNewline = text.endsWith('\n');
    const lines = endsWithNewline ? text.slice(0, -1).split('\n') : text.split('\n');
    const body = lines.map((line) => `+${line}`);
    if (!endsWithNewline) {
        body.push('\\ No newline at end of file');
    }

    return `${[...header, `@@ -0,0 +1,${String(lines.length)} @@`, ...body].join('\n')}\n`;
}
