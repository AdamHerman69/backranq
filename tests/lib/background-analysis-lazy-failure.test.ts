import { afterEach, describe, expect, it, vi } from 'vitest';

describe('background analysis lazy-module failures', () => {
    afterEach(() => {
        vi.clearAllMocks();
        vi.resetModules();
        vi.doUnmock('@/lib/preferences');
        vi.doUnmock('@/lib/analysis/analysisCompletion');
        vi.unstubAllGlobals();
    });

    it('publishes a failed completion and releases the active run', async () => {
        const publishAnalysisCompletion = vi.fn();
        vi.doMock('@/lib/preferences', () => {
            throw new Error('preferences chunk failed');
        });
        vi.doMock('@/lib/analysis/analysisCompletion', () => ({
            clearLastAnalysisCompletion: vi.fn(),
            publishLibraryChanged: vi.fn(),
            publishAnalysisCompletion,
            createBrowserAnalysisCompletion: (args: {
                ownerId: string;
                requested: number;
                succeeded: number;
                failed: number;
                error?: string;
            }) => ({
                id: 'failed-completion',
                ownerId: args.ownerId,
                source: 'browser' as const,
                status: 'failed' as const,
                requested: args.requested,
                succeeded: args.succeeded,
                failed: args.failed,
                trainingMomentsGenerated: 0,
                pendingAtCompletion: 2,
                completedAt: new Date().toISOString(),
                error: args.error,
            }),
        }));
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => Response.json({ total: 2 }))
        );

        const { backgroundAnalysis } = await import(
            '@/lib/analysis/backgroundAnalysisManager'
        );
        backgroundAnalysis.setOwner('user-a');
        backgroundAnalysis.enqueueGameDbIds('user-a', ['game-a', 'game-b']);

        await vi.waitFor(() => {
            expect(backgroundAnalysis.snapshot()).toMatchObject({
                state: 'error',
                totalGames: 0,
                queuedGames: 0,
                lastError: expect.any(String),
                lastCompletion: {
                    status: 'failed',
                    requested: 2,
                    succeeded: 0,
                    failed: 2,
                },
            });
        });
        expect(publishAnalysisCompletion).toHaveBeenCalledTimes(1);
        expect(
            backgroundAnalysis.enqueueGameDbIds('user-a', ['game-c'])
        ).toEqual({ acceptedIds: ['game-c'], skippedIds: [] });
        backgroundAnalysis.setOwner(null);
    });
});
