import { fixtureIteration } from '@sherpa/fixtures';
import type { Thread } from '@sherpa/protocol';
import { useEffect, useState } from 'react';

import { PrCommentsModal } from '../../components/pr-comments-modal.tsx';
import type { ComposerTransport } from '../../threads/composer.js';
import { createThreadStore } from '../../threads/store.js';

const DATA = fixtureIteration('medium');
const FILE_IDS = new Set(DATA.diff.files.map((file) => file.fileId));
const NOW = Date.parse('2026-08-31T12:00:00.000Z');
const AUTHOR = { login: 'alice', displayName: 'Alice Ingram', bot: false } as const;
const DRAFT = thread('gallery-pr-draft', 'We need to state what happens on a second Ship explicitly.', true, '2026-08-31T11:42:00.000Z');
const EDITING_DRAFT = thread(
    'gallery-pr-editing',
    'There is a race here, but a different one: `DISPATCH_LOCK` is acquired after reading the state.',
    true,
    '2026-08-31T10:20:00.000Z',
);
const PUBLISHED = thread(
    'gallery-pr-published',
    'Checked the transaction boundaries. The **lock order** is now unambiguous.',
    false,
    '2026-08-31T11:18:00.000Z',
);
const TRANSPORT: ComposerTransport = {
    save: () => Promise.resolve(DRAFT.root),
    update: () => Promise.resolve(),
    delete: () => Promise.resolve(),
};

export const M2F_T24_STATES = [
    {
        id: 'pr-comments-modal-mixed',
        title: 'draft, published comment and editing',
        render: () => <MixedModalState />,
    },
    {
        id: 'pr-comments-modal-empty',
        title: 'empty',
        render: () => <ModalState threads={[]} />,
    },
] as const;

function MixedModalState() {
    const [store] = useState(() => createThreadStore([PUBLISHED, EDITING_DRAFT, DRAFT], FILE_IDS));
    useEffect(() => {
        document.querySelector<HTMLButtonElement>(`[aria-label="Edit draft ${EDITING_DRAFT.root.id}"]`)?.click();
    }, []);
    return <PrCommentsModal pr={DATA.pr} store={store} transport={TRANSPORT} now={NOW} initialLayout="visual" onClose={() => undefined} />;
}

function ModalState({ threads }: { threads: readonly Thread[] }) {
    const [store] = useState(() => createThreadStore(threads, FILE_IDS));
    return <PrCommentsModal pr={DATA.pr} store={store} transport={TRANSPORT} now={NOW} initialLayout="visual" onClose={() => undefined} />;
}

function thread(id: string, body: string, draft: boolean, createdAt: string): Thread {
    return {
        id,
        anchor: null,
        resolved: false,
        resolvedBy: null,
        outdated: false,
        pinnedTo: null,
        root: {
            id: `${id}-comment`,
            author: AUTHOR,
            body,
            draft,
            // The medium fixture supports issue: a comment without it has the status off, not absent.
            issue: false,
            createdAt,
            editedAt: null,
            replies: [],
        },
    };
}
