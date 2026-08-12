import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    parseServerAnalysisBatchResponse,
    queueServerAnalysisBatch,
    readTrackedServerAnalysisRequests,
    reconcileTrackedServerAnalysis,
} from '@/lib/analysis/serverAnalysisCoordinator';

function jsonResponse(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
        headers: { 'content-type': 'application/json' },
        status,
    });
}

function batch(requestId: string, requested = 1) {
    return {
        batch: {
            id: 'batch-1',
            requestId,
            status: 'QUEUED',
            counts: {
                total: requested,
                pending: 0,
                queued: requested,
                running: 0,
                succeeded: 0,
                failed: 0,
                jobFailed: 0,
                skipped: 0,
            },
        },
    };
}

describe('server analysis client coordinator', () => {
    const values = new Map<string, string>();

    beforeEach(() => {
        values.clear();
        vi.useFakeTimers();
        vi.stubGlobal('window', { dispatchEvent: vi.fn() });
        vi.stubGlobal('localStorage', {
            getItem: (key: string) => values.get(key) ?? null,
            setItem: (key: string, value: string) => values.set(key, value),
            removeItem: (key: string) => values.delete(key),
        });
        vi.stubGlobal(
            'CustomEvent',
            class TestCustomEvent {
                type: string;
                detail: unknown;
                constructor(type: string, init?: { detail?: unknown }) {
                    this.type = type;
                    this.detail = init?.detail;
                }
            }
        );
    });

    afterEach(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('keeps a timed-out accepted request indeterminate and reconciles it by request id', async () => {
        let postedRequestId = '';
        vi.stubGlobal(
            'fetch',
            vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
                if (String(input) === '/api/analysis/batches') {
                    postedRequestId = JSON.parse(String(init?.body)).requestId;
                    return await new Promise<Response>((_resolve, reject) => {
                        init?.signal?.addEventListener('abort', () =>
                            reject(new DOMException('Aborted', 'AbortError'))
                        );
                    });
                }
                return jsonResponse(batch(postedRequestId));
            })
        );

        const promise = queueServerAnalysisBatch({
            ownerId: 'user-a',
            gameIds: ['game-1'],
            force: true,
            timeoutMs: 5,
        });
        await vi.advanceTimersByTimeAsync(5);
        const result = await promise;

        expect(result).toMatchObject({
            state: 'confirming',
            requestId: postedRequestId,
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(readTrackedServerAnalysisRequests('user-a')).toMatchObject([
            {
                id: 'batch-1',
                requestId: postedRequestId,
                status: 'QUEUED',
            },
        ]);
    });

    it('reuses the unknown request id instead of creating a second force request', async () => {
        const postBodies: Array<{ requestId: string }> = [];
        vi.stubGlobal(
            'fetch',
            vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
                if (String(input) === '/api/analysis/batches') {
                    postBodies.push(JSON.parse(String(init?.body)));
                    return await new Promise<Response>((_resolve, reject) => {
                        init?.signal?.addEventListener('abort', () =>
                            reject(new DOMException('Aborted', 'AbortError'))
                        );
                    });
                }
                return jsonResponse({}, 404);
            })
        );

        const firstPromise = queueServerAnalysisBatch({
            ownerId: 'user-a',
            gameIds: ['game-1'],
            force: true,
            timeoutMs: 5,
        });
        await vi.advanceTimersByTimeAsync(5);
        const first = await firstPromise;
        const second = await queueServerAnalysisBatch({
            ownerId: 'user-a',
            gameIds: ['game-1'],
            force: true,
        });

        expect(second.requestId).toBe(first.requestId);
        expect(new Set(postBodies.map((body) => body.requestId))).toEqual(
            new Set([first.requestId])
        );
    });

    it('creates an independent request for a different payload', async () => {
        const requestIds: string[] = [];
        vi.stubGlobal(
            'fetch',
            vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
                if (String(input) === '/api/analysis/batches') {
                    const body = JSON.parse(String(init?.body)) as {
                        requestId: string;
                    };
                    requestIds.push(body.requestId);
                    return await new Promise<Response>((_resolve, reject) => {
                        init?.signal?.addEventListener('abort', () =>
                            reject(new DOMException('Aborted', 'AbortError'))
                        );
                    });
                }
                return jsonResponse({}, 404);
            })
        );

        const first = queueServerAnalysisBatch({
            ownerId: 'user-a',
            gameIds: ['game-1'],
            force: true,
            timeoutMs: 5,
        });
        await vi.advanceTimersByTimeAsync(5);
        await first;
        const second = queueServerAnalysisBatch({
            ownerId: 'user-a',
            gameIds: ['game-2'],
            force: true,
            timeoutMs: 5,
        });
        await vi.advanceTimersByTimeAsync(5);
        await second;

        expect(new Set(requestIds).size).toBe(2);
    });

    it('reposts the persisted payload with the same request id after a reload-style 404', async () => {
        let persistedRequestId = '';
        let phase: 'timeout' | 'reconcile' = 'timeout';
        const repostIds: string[] = [];
        vi.stubGlobal(
            'fetch',
            vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
                if (String(input) === '/api/analysis/batches') {
                    const body = JSON.parse(String(init?.body)) as {
                        requestId: string;
                    };
                    if (phase === 'timeout') {
                        persistedRequestId = body.requestId;
                        return await new Promise<Response>((_resolve, reject) => {
                            init?.signal?.addEventListener('abort', () =>
                                reject(new DOMException('Aborted', 'AbortError'))
                            );
                        });
                    }
                    repostIds.push(body.requestId);
                    return jsonResponse(batch(body.requestId));
                }
                return jsonResponse({}, 404);
            })
        );

        const initial = queueServerAnalysisBatch({
            ownerId: 'user-a',
            gameIds: ['game-1'],
            force: true,
            timeoutMs: 5,
        });
        await vi.advanceTimersByTimeAsync(5);
        await initial;
        phase = 'reconcile';
        await reconcileTrackedServerAnalysis('user-a');

        expect(repostIds).toEqual([persistedRequestId]);
        expect(readTrackedServerAnalysisRequests('user-a')[0]).toMatchObject({
            id: 'batch-1',
            requestId: persistedRequestId,
            status: 'QUEUED',
        });
        expect(
            readTrackedServerAnalysisRequests('user-a')[0]?.confirmingPayload
        ).toBeUndefined();
    });

    it('parses a 2,000-game summary without job-id truncation', () => {
        expect(
            parseServerAnalysisBatchResponse(batch('request-1', 2_000))
        ).toMatchObject({
            requestId: 'request-1',
            requested: 2_000,
            queued: 2_000,
        });
    });

    it('does not report historical linked item counts as active queue work', () => {
        expect(
            parseServerAnalysisBatchResponse({
                batch: {
                    id: 'batch-1',
                    requestId: 'request-1',
                    status: 'COMPLETED',
                    completedAt: '2026-08-12T12:00:00.000Z',
                    counts: {
                        total: 2,
                        pending: 0,
                        queued: 0,
                        attached: 2,
                        running: 0,
                        succeeded: 2,
                        failed: 0,
                        jobFailed: 0,
                        skipped: 0,
                    },
                },
            })
        ).toMatchObject({
            status: 'COMPLETED',
            queued: 0,
            succeeded: 2,
        });
    });

    it('reports queue-disabled cancelled items as failed work', () => {
        expect(
            parseServerAnalysisBatchResponse({
                batch: {
                    id: 'batch-1',
                    requestId: 'request-1',
                    status: 'FAILED',
                    completedAt: '2026-08-12T12:00:00.000Z',
                    counts: {
                        total: 2,
                        pending: 0,
                        queued: 0,
                        running: 0,
                        succeeded: 0,
                        failed: 0,
                        cancelled: 2,
                        jobFailed: 0,
                        jobCancelled: 0,
                        skipped: 0,
                    },
                },
            })
        ).toMatchObject({
            status: 'FAILED',
            failed: 2,
            succeeded: 0,
        });
    });
});
