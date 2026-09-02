import type { AgentNote, ChatAnchor, ChatExchange, UiTask, WorkerStatus } from '@sherpa/protocol';

import { ChatPanel } from '../../components/chat-panel.tsx';

const CONNECTED: WorkerStatus = {
    kind: 'connected',
    workerId: 'gallery-worker',
    harness: 'claude-code',
    model: 'opus-5',
    registeredAt: '2026-09-01T09:00:00.000Z',
    lastSeenAt: '2026-09-01T10:00:00.000Z',
};
const ANCHOR: ChatAnchor = {
    diffId: 'gallery-iteration',
    fileId: 'gallery-chat-file',
    path: 'src/review/cache.ts',
    side: 'new',
    start: 41,
    end: 43,
};
const ROUTE_TASK: UiTask = {
    id: 91,
    type: 'route.section',
    priority: 'background',
    status: 'leased',
    heldByWorker: true,
    attempt: 1,
    instructions: 'Fill a route stop',
    progressText: 'Reading the changes',
    result: null,
    failReason: null,
    createdAt: '2026-09-01T09:59:00.000Z',
    updatedAt: '2026-09-01T10:00:00.000Z',
};

function exchange(
    id: number,
    status: ChatExchange['status'],
    overrides: Partial<ChatExchange> = {},
): ChatExchange {
    return {
        id,
        question: 'Why is the cache check before data loading?',
        anchor: ANCHOR,
        status,
        taskId: id,
        answer: status === 'done' ? 'The check separates a **cache hit** from loading. This keeps the fast path.' : null,
        progressText: status === 'running' ? 'Checking callers' : null,
        error: status === 'failed' ? 'The model finished the task without an answer.' : null,
        createdAt: `2026-09-01T10:00:0${String(id)}.000Z`,
        updatedAt: `2026-09-01T10:00:0${String(id)}.000Z`,
        ...overrides,
    };
}

const HISTORY = [
    exchange(1, 'done'),
    exchange(2, 'done', {
        question: 'Which changes in the PR need manual verification?',
        anchor: null,
        answer: 'Check request cancellation and retry after an error: both paths change the queue state.',
        createdAt: '2026-09-01T10:02:00.000Z',
        updatedAt: '2026-09-01T10:03:00.000Z',
    }),
];
const NOTE: AgentNote = {
    id: 31,
    exchangeId: 1,
    anchor: ANCHOR,
    text: 'The check separates cache hits from loading.',
    lostAnchor: false,
    origin: { commit: 'abcdef1', anchor: ANCHOR },
    createdAt: '2026-09-01T10:01:00.000Z',
};

export const M3_T6_STATES = [
    {
        id: 'chat-empty',
        title: 'empty',
        render: () => <ChatState worker={CONNECTED} exchanges={[]} tasks={[]} />,
    },
    {
        id: 'chat-queued',
        title: 'queued',
        render: () => <ChatState worker={CONNECTED} exchanges={[exchange(1, 'queued')]} tasks={[ROUTE_TASK]} />,
    },
    {
        id: 'chat-answering',
        title: 'answering with progressText',
        render: () => <ChatState worker={CONNECTED} exchanges={[exchange(1, 'running')]} tasks={[]} />,
    },
    {
        id: 'chat-failed',
        title: 'failed',
        render: () => <ChatState worker={CONNECTED} exchanges={[exchange(1, 'failed')]} tasks={[]} />,
    },
    {
        id: 'chat-disconnected',
        title: 'disconnected',
        render: () => <ChatState worker={{ kind: 'never' }} exchanges={HISTORY} tasks={[]} />,
    },
    {
        id: 'chat-history',
        title: 'history with an anchor and a note',
        render: () => <ChatState worker={CONNECTED} exchanges={HISTORY} notes={[NOTE]} tasks={[]} />,
    },
] as const;

function ChatState({
    worker,
    exchanges,
    notes = [],
    tasks,
}: {
    worker: WorkerStatus;
    exchanges: readonly ChatExchange[];
    notes?: readonly AgentNote[];
    tasks: readonly UiTask[];
}) {
    return (
        <div className="gallery-chat-panel">
            <ChatPanel
                prKey="fixture-4821"
                worker={worker}
                tasks={tasks}
                exchanges={exchanges}
                notes={notes}
                loading={false}
                error={null}
                reconnectCommand="/sherpa fixture-4821"
                anchor={exchanges.at(-1)?.anchor ?? null}
                focusRequest={0}
                scrollRequest={null}
                onScrollRequestHandled={() => undefined}
                onClose={() => undefined}
                onRemoveAnchor={() => undefined}
                onAsk={() => Promise.resolve(exchange(9, 'queued'))}
                onCancel={() => Promise.resolve()}
                onRetry={() => Promise.resolve()}
                onNavigate={() => undefined}
                onNavigateToNote={() => undefined}
                now={Date.parse('2026-09-01T10:00:20.000Z')}
            />
        </div>
    );
}
