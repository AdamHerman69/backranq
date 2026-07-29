import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    LIBRARY_CHANGED_EVENT,
    createServerAnalysisBatch,
    publishAnalysisCompletion,
    readLastAnalysisCompletion,
    readServerAnalysisBatch,
    writeServerAnalysisBatch,
} from '@/lib/analysis/analysisCompletion';
import {
    acceptedServerAnalysisJobIds,
    registerServerAnalysisEnqueue,
} from '@/lib/games/serverAnalysisTracking';
import type { EnqueueServerAnalysisJobsResult } from '@/lib/services/gameSync';

function enqueueResult(
    jobs: EnqueueServerAnalysisJobsResult['jobs']
): EnqueueServerAnalysisJobsResult {
    return {
        queued: jobs?.filter((job) => job.acceptedInBatch === true).length ?? 0,
        skipped: jobs?.filter((job) => job.acceptedInBatch !== true).length ?? 0,
        jobs,
    };
}

describe('games server analysis tracking', () => {
    const values = new Map<string, string>();
    const dispatchEvent = vi.fn();

    beforeEach(() => {
        values.clear();
        dispatchEvent.mockClear();
        vi.stubGlobal('window', { dispatchEvent });
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
        vi.unstubAllGlobals();
    });

    it('extracts only concrete jobs accepted by this enqueue', () => {
        expect(
            acceptedServerAnalysisJobIds(
                enqueueResult([
                    {
                        id: 'job-new',
                        gameId: 'game-1',
                        status: 'QUEUED',
                        acceptedInBatch: true,
                        queuedReason: 'manual-reanalysis',
                    },
                    {
                        id: 'job-existing',
                        gameId: 'game-2',
                        status: 'RUNNING',
                        acceptedInBatch: false,
                        queuedReason: 'manual-reanalysis',
                    },
                ])
            )
        ).toEqual(['job-new']);
    });

    it('merges with the owner batch, clears stale completion, and publishes a refresh event', () => {
        writeServerAnalysisBatch(
            'user-a',
            createServerAnalysisBatch({
                ownerId: 'user-a',
                queued: 1,
                jobIds: ['job-existing'],
                failedAtStart: 0,
                trainingMomentsAtStart: null,
                pendingAtStart: null,
            })
        );
        publishAnalysisCompletion({
            id: 'old-completion',
            ownerId: 'user-a',
            source: 'server',
            status: 'succeeded',
            requested: 1,
            succeeded: 1,
            failed: 0,
            trainingMomentsGenerated: null,
            pendingAtCompletion: null,
            completedAt: new Date().toISOString(),
        });
        dispatchEvent.mockClear();

        const batch = registerServerAnalysisEnqueue({
            ownerId: 'user-a',
            result: enqueueResult([
                {
                    id: 'job-new',
                    gameId: 'game-new',
                    status: 'QUEUED',
                    acceptedInBatch: true,
                    queuedReason: 'manual-reanalysis',
                },
            ]),
        });

        expect(batch?.ownerId).toBe('user-a');
        expect(batch?.jobIds).toEqual(['job-existing', 'job-new']);
        expect(readServerAnalysisBatch('user-a')?.jobIds).toEqual([
            'job-existing',
            'job-new',
        ]);
        expect(readLastAnalysisCompletion('user-a')).toBeNull();
        expect(
            dispatchEvent.mock.calls.some(
                ([event]) => event?.type === LIBRARY_CHANGED_EVENT
            )
        ).toBe(true);
    });
});
