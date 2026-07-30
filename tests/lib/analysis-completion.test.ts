import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    createBrowserAnalysisCompletion,
    createServerAnalysisBatch,
    deriveServerAnalysisCompletion,
    deriveServerJobCompletion,
    mergeServerAnalysisBatches,
    readLastAnalysisCompletion,
    readServerAnalysisBatch,
    writeServerAnalysisBatch,
    publishAnalysisCompletion,
    type ServerAnalysisObservation,
} from '@/lib/analysis/analysisCompletion';
import {
    backgroundAnalysis,
    formatAnalysisSaveError,
} from '@/lib/analysis/backgroundAnalysisManager';

function observation(
    overrides: Partial<ServerAnalysisObservation> = {}
): ServerAnalysisObservation {
    return {
        queued: 0,
        running: 0,
        failed: 0,
        trainingMomentCount: 0,
        pendingCount: 0,
        ...overrides,
    };
}

describe('analysis completion summaries', () => {
    it('formats save failures without exposing raw response details', () => {
        expect(
            formatAnalysisSaveError(500, {
                unexpected: '{"database":"internal"}',
            })
        ).toBe(
            "We couldn't save this analysis. No changes were written. Retry the analysis."
        );
        expect(
            formatAnalysisSaveError(503, {
                error:
                    'Saving the analysis took too long. No changes were written. Retry the analysis.',
                retryable: true,
            })
        ).toBe(
            'Saving the analysis took too long. No changes were written. Retry the analysis.'
        );
    });

    it('does not complete a fallback server batch while work remains active', () => {
        const batch = createServerAnalysisBatch({
            ownerId: 'user-a',
            queued: 3,
            failedAtStart: 1,
            trainingMomentsAtStart: 10,
            pendingAtStart: 7,
        });

        expect(
            deriveServerAnalysisCompletion(
                observation({ queued: 3, failed: 1 }),
                observation({ running: 1, failed: 1 }),
                batch
            )
        ).toBeNull();
    });

    it('treats successful force reanalysis as success even when pending is unchanged', () => {
        const batch = createServerAnalysisBatch({
            ownerId: 'user-a',
            queued: 2,
            failedAtStart: 4,
            trainingMomentsAtStart: 10,
            pendingAtStart: 0,
        });

        const summary = deriveServerAnalysisCompletion(
            observation({ running: 2, failed: 4, pendingCount: 0 }),
            observation({
                failed: 4,
                trainingMomentCount: 12,
                pendingCount: 0,
            }),
            batch
        );

        expect(summary).toMatchObject({
            status: 'succeeded',
            requested: 2,
            succeeded: 2,
            failed: 0,
            pendingAtCompletion: 0,
        });
    });

    it('uses correlated job IDs for exact terminal results', () => {
        const batch = createServerAnalysisBatch({
            ownerId: 'user-a',
            queued: 2,
            jobIds: ['job-1', 'job-2'],
            failedAtStart: 0,
            trainingMomentsAtStart: 4,
            pendingAtStart: 2,
        });
        const summary = deriveServerJobCompletion(
            batch,
            [
                { id: 'job-1', status: 'SUCCEEDED' },
                { id: 'job-2', status: 'FAILED' },
            ],
            { trainingMomentCount: 5, pendingCount: 1 }
        );

        expect(summary).toMatchObject({
            batchId: batch.id,
            status: 'partial',
            succeeded: 1,
            failed: 1,
            trainingMomentsGenerated: 1,
        });
    });

    it('merges overlapping correlated batches instead of overwriting active work', () => {
        const first = createServerAnalysisBatch({
            ownerId: 'user-a',
            queued: 1,
            jobIds: ['job-1'],
            failedAtStart: 0,
            trainingMomentsAtStart: 4,
            pendingAtStart: 2,
        });
        const second = createServerAnalysisBatch({
            ownerId: 'user-a',
            queued: 1,
            jobIds: ['job-2'],
            failedAtStart: 0,
            trainingMomentsAtStart: 4,
            pendingAtStart: 2,
        });

        expect(mergeServerAnalysisBatches(first, second)).toMatchObject({
            id: first.id,
            queued: 2,
            jobIds: ['job-1', 'job-2'],
        });
    });

    it('builds browser requested counts from the final run total, including cancellation', () => {
        expect(
            createBrowserAnalysisCompletion({
                ownerId: 'user-a',
                requested: 4,
                succeeded: 2,
                failed: 0,
                cancelled: true,
                trainingMomentsGenerated: 3,
                pendingAtCompletion: 2,
            })
        ).toMatchObject({
            status: 'cancelled',
            requested: 4,
            succeeded: 2,
        });
    });
});

describe('owner-scoped analysis persistence', () => {
    const values = new Map<string, string>();

    beforeEach(() => {
        values.clear();
        vi.stubGlobal('window', { dispatchEvent: vi.fn() });
        vi.stubGlobal('localStorage', {
            getItem: (key: string) => values.get(key) ?? null,
            setItem: (key: string, value: string) => values.set(key, value),
            removeItem: (key: string) => values.delete(key),
        });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('does not expose user A completion or batch after logout and login as B', () => {
        publishAnalysisCompletion({
            id: 'completion-a',
            ownerId: 'user-a',
            source: 'server',
            status: 'partial',
            requested: 2,
            succeeded: 1,
            failed: 1,
            trainingMomentsGenerated: 1,
            pendingAtCompletion: 1,
            completedAt: new Date().toISOString(),
        });
        writeServerAnalysisBatch(
            'user-a',
            createServerAnalysisBatch({
                ownerId: 'user-a',
                queued: 1,
                jobIds: ['job-a'],
                failedAtStart: 0,
                trainingMomentsAtStart: 0,
                pendingAtStart: 1,
            })
        );

        expect(readLastAnalysisCompletion('user-b')).toBeNull();
        expect(readServerAnalysisBatch('user-b')).toBeNull();
        expect(readLastAnalysisCompletion('user-a')?.id).toBe('completion-a');
    });

    it('rejects manager work submitted for a different active owner', () => {
        backgroundAnalysis.setOwner('user-a');
        expect(() =>
            backgroundAnalysis.enqueueGameDbIds('user-b', ['game-b'])
        ).toThrow(/session changed/i);
        backgroundAnalysis.setOwner(null);
    });
});
