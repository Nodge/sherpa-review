import type { FileContent, FileDiff } from '@sherpa/protocol';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { DiffFileModel } from '../../diff/model.js';
import type { ContextExpandRequest, ContextExpandResult } from '../../diff-view/context-expansion.js';
import { expandContext } from '../../diff-view/context-expansion.js';
import type { DiffViewStore } from '../../diff-view/store.js';
import { useT } from '../../i18n/index.js';

export interface RouteParseOptions {
    readonly files: readonly FileDiff[];
    readonly store: DiffViewStore;
    readonly parse: (file: FileDiff) => Promise<DiffFileModel>;
    readonly loadContent: (fileId: string) => Promise<FileContent | null>;
    /** The host provides file contents. Without them, gaps expand only within the patch. */
    readonly contentAvailable: boolean;
}

export interface RouteParse {
    readonly parseErrors: ReadonlyMap<string, string>;
    readonly failedFiles: ReadonlySet<string>;
    readonly requestParse: (fileIds: readonly string[]) => void;
    readonly retryParse: (fileIds: readonly string[]) => void;
    readonly retryFailed: () => void;
    readonly expand: (fileId: string, request: ContextExpandRequest) => Promise<ContextExpandResult>;
}

/**
 * Route patch parsing: request files, retry failures and expand gaps. Models
 * go into the shared diff store, so the route does not reparse what Full diff has parsed.
 */
export function useRouteParse({ files, store, parse, loadContent, contentAvailable }: RouteParseOptions): RouteParse {
    const t = useT();
    // Files whose parsing failed: they have no model until the reviewer requests a retry,
    // and their counts must not be treated as unfinished, or "Other" would wait forever.
    const [parseErrors, setParseErrors] = useState<ReadonlyMap<string, string>>(new Map());
    const failedFiles = useMemo(() => new Set(parseErrors.keys()), [parseErrors]);

    // Patch parsing: request a stop's files once it has entered the viewport. Parse the rest
    // in the background after the first frame, or "Other" and the counters would have nothing to count.
    const requested = useRef(new Set<string>());
    const requestParse = useCallback(
        (fileIds: readonly string[]) => {
            for (const fileId of fileIds) {
                const file = files.find((candidate) => candidate.fileId === fileId);
                // The model is already in the shared store (parsed by Full diff or the gallery), so no need to repeat it.
                if (file === undefined || requested.current.has(fileId) || store.getSnapshot().models.has(fileId)) {
                    continue;
                }
                requested.current.add(fileId);
                void parse(file).then(
                    (parsed) => {
                        store.setModel(fileId, parsed);
                    },
                    (error: unknown) => {
                        setParseErrors((previous) =>
                            new Map(previous).set(fileId, error instanceof Error ? error.message : String(error)),
                        );
                    },
                );
            }
        },
        [files, parse, store],
    );
    useEffect(() => {
        const timer = setTimeout(() => {
            requestParse(files.map((file) => file.fileId));
        }, BACKGROUND_PARSE_DELAY);
        return () => {
            clearTimeout(timer);
        };
    }, [files, requestParse]);
    const retryParse = useCallback(
        (fileIds: readonly string[]) => {
            for (const fileId of fileIds) {
                requested.current.delete(fileId);
            }
            setParseErrors((previous) => {
                const next = new Map(previous);
                for (const fileId of fileIds) {
                    next.delete(fileId);
                }
                return next;
            });
            requestParse(fileIds);
        },
        [requestParse],
    );
    const retryFailed = useCallback(() => {
        retryParse([...failedFiles]);
    }, [failedFiles, retryParse]);
    const expand = useCallback(
        (fileId: string, request: ContextExpandRequest): Promise<ContextExpandResult> =>
            expandContext({
                store,
                fileId,
                request,
                contentAvailable,
                loadContent,
                t,
            }),
        [contentAvailable, loadContent, store, t],
    );

    return { parseErrors, failedFiles, requestParse, retryParse, retryFailed, expand };
}

const BACKGROUND_PARSE_DELAY = 300;
