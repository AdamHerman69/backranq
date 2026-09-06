import { afterEach, expect, it, vi } from 'vitest';

// An isolated lifecycle harness: run the actual hook callbacks and actual HTTP
// client/outbox modules, while replacing React rendering and the puzzle engine.
const harness = vi.hoisted(() => ({
    effects: [] as Array<() => void | (() => void)>,
    complete: null as null | ((value: unknown) => void),
    refine: null as null | ((prompt: unknown, request: unknown) => void),
    refs: [] as Array<{ current: unknown }>,
    refIndex: 0,
    ownerId: 'owner-a',
    stateUpdates: [] as unknown[],
}));
vi.mock('react', async (original) => ({
    ...await original(),
    useState: (value: unknown) => [
        typeof value === 'function' ? value() : value,
        (next: unknown) => harness.stateUpdates.push(next),
    ],
    useRef: (value: unknown) => {
        const index = harness.refIndex++;
        return harness.refs[index] ??= { current: value };
    },
    useCallback: (value: unknown) => value,
    useEffect: (effect: () => void | (() => void)) => harness.effects.push(effect),
}));
vi.mock('next-auth/react', () => ({
    useSession: () => ({
        status: 'authenticated',
        data: { user: { id: harness.ownerId } },
    }),
}));
vi.mock('@/lib/hooks/usePuzzleSession', () => ({
    usePuzzleSession: (options: { initialPrompt: unknown; onCompleted: (value: unknown) => void; onRefined: (prompt:unknown,request:unknown)=>void }) => {
        harness.complete = options.onCompleted;
        harness.refine = options.onRefined;
        return {
            prompt: options.initialPrompt,
            phase: 'READY',
            canMove: true,
            activatePrompt: () => {},
            clearPrompt: () => {},
        };
    },
}));
vi.mock('@/lib/training/exposureClient', () => ({ recordPracticeExposureEvent: vi.fn() }));
vi.mock('@/lib/progress/analyticsClient', () => ({ recordProgressEvent: vi.fn() }));
vi.mock('@/lib/browser/postInteractive', () => ({ schedulePostInteractiveTask: () => () => {} }));

import { usePracticeFeed } from '@/lib/hooks/usePracticeFeed';
import {
    trainingQueueStorageKey,
    parseTrainingAttemptQueue,
} from '@/lib/training/offlineQueue';
import type { TrainingPromptDto } from '@/lib/training/api';

let cleanups: Array<() => void> = [];
afterEach(() => {
    for (const cleanup of cleanups) cleanup();
    cleanups = [];
    vi.unstubAllGlobals();
});

function mountPractice(storageUnavailable = false) {
    harness.effects = [];
    harness.refs = [];
    harness.refIndex = 0;
    harness.ownerId = 'owner-a';
    harness.stateUpdates = [];
    const storage = new Map<string, string>();
    vi.stubGlobal('window', {
        localStorage: {
            getItem: (key: string) => storage.get(key) ?? null,
            setItem: (key: string, value: string) => {
                if (storageUnavailable) throw new Error('Storage blocked');
                storage.set(key, value);
            },
            removeItem: (key: string) => storage.delete(key),
        },
        addEventListener() {},
        removeEventListener() {},
        setTimeout,
        clearTimeout,
    });
    vi.stubGlobal('navigator', { onLine: true });
    let attemptSignal: AbortSignal | undefined;
    const requestResolvers: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn((_url, options) => {
        attemptSignal = options.signal;
        return new Promise<Response>((resolve, reject) => {
            requestResolvers.push(resolve);
            attemptSignal!.addEventListener('abort', () =>
                reject(new DOMException('Navigation aborted request', 'AbortError'))
            );
        });
    });
    vi.stubGlobal('fetch', fetchMock);
    const prompt = {
        id: 'moment-a',
        solutionRevisionId: 'revision-a',
        fen: 'unused',
        sideToMove: 'w',
        grading: {},
    } as TrainingPromptDto;
    const hookOptions = {
        ownerIdOverride: 'owner-a',
        initialPractice: {
            ownerId: 'owner-a', prompt, nextCursor: null,
            appliedFilters: {}, feedStarted: true,
            feedHadPositions: true, loadError: null,
        },
    };
    // React hooks are replaced by the deterministic lifecycle harness above.
    // eslint-disable-next-line react-hooks/rules-of-hooks
    const hook = usePracticeFeed(hookOptions);
    cleanups = harness.effects.map((effect) => effect()).filter(
        (value): value is () => void => typeof value === 'function'
    );
    const complete = () => harness.complete!({
        prompt,
        terminalReason: 'REVEALED',
        request: {
            kind: 'RECORD', clientAttemptId: 'attempt-a',
            completedAt: '2026-07-30T08:00:00.000Z',
            solutionRevisionId: 'revision-a', status: 'REVEALED', steps: [],
        },
    });
    return {
        hook, storage, complete, fetchMock,
        refine: () => harness.refine!(prompt, {kind:'ENRICH',clientAttemptId:'attempt-a',solutionRevisionId:'revision-a',clientEvidenceId:'evidence-a',stepIndex:0,evaluatedAt:'2026-07-30T08:00:01.000Z',grade:'STRONG',clientEvidence:{}}),
        signal: () => attemptSignal,
        changeOwner: () => {
            harness.ownerId = 'owner-b';
            harness.refIndex = 0;
            // Replay render with the same mocked refs and a new auth owner.
            // eslint-disable-next-line react-hooks/rules-of-hooks
            usePracticeFeed(hookOptions);
        },
        respond: (body: unknown, status = 200, index = requestResolvers.length - 1) => requestResolvers[index]!(
            new Response(JSON.stringify(body), {
                status, headers: { 'content-type': 'application/json' },
            })
        ),
        queue: () => parseTrainingAttemptQueue(
            storage.get(trainingQueueStorageKey('owner-a')) ?? null
        ),
    };
}

it('keeps a completed online attempt durable if navigation aborts its POST', async () => {
    const test = mountPractice();
    test.complete();
    expect(test.signal()).toBeDefined();
    for (const cleanup of cleanups) cleanup();
    await Promise.resolve();
    await Promise.resolve();
    expect(test.signal()!.aborted).toBe(true);
    expect(test.queue().map((entry) => entry.request.clientAttemptId)).toContain('attempt-a');
    expect(test.storage.has(trainingQueueStorageKey('owner-b'))).toBe(false);
});

it('does not flush a direct write twice and removes it only after server confirmation', async () => {
    const test = mountPractice();
    test.complete();
    expect(test.queue()).toHaveLength(1);
    await test.hook.flushQueue();
    expect(test.fetchMock).toHaveBeenCalledTimes(1);
    test.respond({ attemptId: 'server-attempt-a', status: 'RECORDED' });
    await vi.waitFor(() => expect(test.queue()).toEqual([]));
});

it('preserves another result queued while the direct request is pending', async () => {
    const test = mountPractice();
    test.complete();
    const first = test.queue()[0]!;
    const concurrent = {
        ...first,
        request: { ...first.request, clientAttemptId: 'attempt-b' },
    };
    test.storage.set(trainingQueueStorageKey('owner-a'), JSON.stringify([first, concurrent]));
    test.respond({ attemptId: 'server-attempt-a', status: 'RECORDED' });
    await vi.waitFor(() => expect(test.queue()).toEqual([concurrent]));
});

it('marks a rejected durable direct write as needing attention', async () => {
    const test = mountPractice();
    test.complete();
    test.respond({ error: 'Revision changed', code: 'STALE_REVISION' }, 409);
    await vi.waitFor(() => expect(test.queue()[0]).toMatchObject({
        state: 'NEEDS_ATTENTION',
        attemptCount: 1,
        lastError: { status: 409, code: 'STALE_REVISION' },
    }));
});

it('retries a transient direct failure once without a repeated flush loop', async () => {
    const test = mountPractice();
    test.complete();
    await test.hook.flushQueue();
    expect(test.fetchMock).toHaveBeenCalledTimes(1);
    test.respond({ error: 'Temporarily unavailable' }, 500);
    await vi.waitFor(() => expect(test.fetchMock).toHaveBeenCalledTimes(2));
    test.respond({ error: 'Still unavailable' }, 500);
    await vi.waitFor(() => expect(test.queue()[0]).toMatchObject({
        state: 'PENDING', attemptCount: 2,
    }));
    expect(test.fetchMock).toHaveBeenCalledTimes(2);
});

it('leaves the original owner queue intact when the account changes during a write', async () => {
    const test = mountPractice();
    test.complete();
    const original = test.queue();
    test.changeOwner();
    test.respond({ attemptId: 'server-attempt-a', status: 'RECORDED' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(test.queue()).toEqual(original);
    expect(test.storage.has(trainingQueueStorageKey('owner-b'))).toBe(false);
});

it('reports unavailable local storage while still attempting the online save', () => {
    const test = mountPractice(true);
    test.complete();
    expect(test.fetchMock).toHaveBeenCalledTimes(1);
    expect(test.queue()).toEqual([]);
    expect(harness.stateUpdates).toContain(
        'Your result is graded, but local history storage is unavailable.'
    );
});

it('defers the one-shot retry until an already active flush has settled', async () => {
    const test = mountPractice();
    test.complete();
    const first = test.queue()[0]!;
    test.storage.set(trainingQueueStorageKey('owner-a'), JSON.stringify([
        first,
        { ...first, request: { ...first.request, clientAttemptId: 'older-attempt' } },
    ]));
    const flushing = test.hook.flushQueue();
    expect(test.fetchMock).toHaveBeenCalledTimes(2);
    test.respond({ error: 'Direct write unavailable' }, 500, 0);
    await vi.waitFor(() => expect(test.queue()[0]?.attemptCount).toBe(1));
    expect(test.fetchMock).toHaveBeenCalledTimes(2);
    test.respond({ error: 'Older write unavailable' }, 500, 1);
    await flushing;
    await vi.waitFor(() => expect(test.fetchMock).toHaveBeenCalledTimes(3));
    test.respond({ error: 'Still unavailable' }, 500, 2);
    await vi.waitFor(() => expect(test.queue()[0]?.attemptCount).toBe(2));
    expect(test.fetchMock).toHaveBeenCalledTimes(3);
});

it('persists a refinement separately without removing its in-flight original event', async () => {
    const test = mountPractice();
    test.complete(); test.refine();
    expect(test.queue().map(entry=>entry.request.kind)).toEqual(['RECORD','ENRICH']);
    expect(test.fetchMock).toHaveBeenCalledTimes(2);
    await test.hook.flushQueue();
    expect(test.fetchMock).toHaveBeenCalledTimes(2);
    test.respond({attemptId:'server-attempt-a',status:'RECORDED'},200,0);
    await vi.waitFor(()=>expect(test.queue().map(entry=>entry.request.kind)).toEqual(['ENRICH']));
    test.respond({attemptId:'server-attempt-a',status:'ENRICHED',corrected:true},200,1);
    await vi.waitFor(()=>expect(test.queue()).toEqual([]));
});
