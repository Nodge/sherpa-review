import type { FileContent } from '@sherpa/protocol';

import type { Translate } from '../i18n/index.js';
import type { ExpandDirection, FileExpansion, GapKey } from './expand.js';
import type { DiffViewStore } from './store.js';

export type ContextExpandRequest =
    | {
          readonly kind: 'gap';
          readonly gapKey: GapKey;
          readonly direction: ExpandDirection;
          readonly amount?: number;
      }
    | { readonly kind: 'file'; readonly gapKeys?: readonly GapKey[] };

export interface ContextExpandResult {
    readonly feedback: string | null;
    readonly content: FileContent | null;
    readonly expansion: FileExpansion;
}

export interface GapExpandResult {
    readonly feedback: string | null;
    readonly loaded: number;
    readonly hidden: number;
    /** Remaining changed lines from other stops under the same key. Expansion splits the gap into pieces. */
    readonly hiddenChanged: number;
}

interface ExpandContextOptions {
    readonly store: DiffViewStore;
    readonly fileId: string;
    readonly request: ContextExpandRequest;
    readonly contentAvailable: boolean;
    readonly loadContent: (fileId: string) => Promise<FileContent | null>;
    /** A failed content load produces a ready-to-display message in the file card. */
    readonly t: Translate;
}

/** Shared lazy content fetch and action application for Full diff and Route. */
export async function expandContext(options: ExpandContextOptions): Promise<ContextExpandResult> {
    const { store, fileId, request, contentAvailable, loadContent, t } = options;
    const result = (feedback: string | null): ContextExpandResult => {
        const snapshot = store.getSnapshot();
        return {
            feedback,
            content: snapshot.content.get(fileId) ?? null,
            expansion: snapshot.expansion.get(fileId) ?? new Map(),
        };
    };
    if (!contentAvailable) {
        return result(null);
    }

    if (!store.getSnapshot().content.has(fileId)) {
        let content: FileContent | null;
        try {
            content = await loadContent(fileId);
        } catch (error: unknown) {
            const reason = (error instanceof Error ? error.message : String(error)).replace(/\s*\.\s*$/, '');
            return result(t('diff.contextFailed', reason));
        }
        store.setContent(fileId, content);
        if (content === null) {
            return result(null);
        }
    }

    if (request.kind === 'file') {
        store.expandFile(fileId, request.gapKeys);
    } else {
        store.expandGap(fileId, request.gapKey, request.direction, request.amount);
    }
    return result(null);
}
