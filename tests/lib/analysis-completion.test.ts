import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const engineHarness = vi.hoisted(() => ({
    instances: [] as Array<{
        cancelAll: ReturnType<typeof vi.fn>;
        terminate: ReturnType<typeof vi.fn>;
        getIdentity: ReturnType<typeof vi.fn>;
    }>,
    extract: vi.fn(),
}));

vi.mock('@/lib/analysis/stockfishClient', () => ({
    StockfishClient: class MockStockfishClient {
        cancelAll = vi.fn();
        terminate = vi.fn();
        getIdentity = vi.fn().mockResolvedValue({
            name: 'Mock Stockfish',
            source: 'test',
            options: {},
        });

        constructor() {
            engineHarness.instances.push(this);
        }
    },
}));

vi.mock('@/lib/analysis/extractTrainingMoments', () => ({
    extractTrainingMomentsFromGames: engineHarness.extract,
}));

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

function jsonResponse(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

function browserExtractionResult(gameDbId: string, externalId: string) {
    return {
        analysis: new Map([[`lichess:${externalId}`, {}]]),
        manifests: [{ sourceGameId: gameDbId, complete: true }],
        moments: [],
        configSnapshot: {},
        configHash: 'test-config-hash',
    };
}

function stubBrowserAnalysisApi(gameDbId: string, externalId: string) {
    vi.stubGlobal(
        'fetch',
        vi.fn((input: string | URL | Request, init?: RequestInit) => {
            const url = String(input);
            if (url === '/api/user/preferences') {
                return Promise.resolve(
                    jsonResponse({
                        preferences: {
                            analysisQuality: 'STANDARD',
                            trainingCoveragePreset: 'ALL_CONFIRMED',
                            trainingGradingTolerance: 'PRACTICAL',
                        },
                    })
                );
            }
            if (url === `/api/games/${gameDbId}` && !init?.method) {
                return Promise.resolve(
                    jsonResponse({
                        game: {
                            provider: 'LICHESS',
                            externalId,
                            url: null,
                            playedAt: '2026-08-13T00:00:00.000Z',
                            timeClass: 'BLITZ',
                            rated: true,
                            result: '1-0',
                            termination: null,
                            whiteName: 'owner-a',
                            whiteRating: 1800,
                            blackName: 'opponent',
                            blackRating: 1750,
                            pgn: '1. e4 e5 2. Nf3 Nc6',
                            sourceUsername: 'owner-a',
                            sourceAccountId: null,
                            userSide: 'WHITE',
                        },
                    })
                );
            }
            if (
                url === `/api/games/${gameDbId}/analysis` &&
                init?.method === 'PUT'
            ) {
                expect(
                    new Headers(init.headers).get('X-Backranq-Owner-Id')
                ).toBe('user-a');
                return Promise.resolve(
                    jsonResponse({
                        ownerId: 'user-a',
                        trainingMoments: { upserted: 0 },
                    })
                );
            }
            if (url === '/api/games?hasAnalysis=false&page=1&limit=1') {
                return Promise.resolve(jsonResponse({ total: 0 }));
            }
            throw new Error(`Unexpected browser analysis request: ${url}`);
        })
    );
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
        engineHarness.instances.length = 0;
        engineHarness.extract.mockReset();
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

    it('does not merge a new browser batch into different active settings', () => {
        vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)));
        backgroundAnalysis.setOwner('user-a');
        backgroundAnalysis.enqueueGameDbIdsWithOptions('user-a', ['game-a'], {
            analysisDefaults: {
                analysisQuality: 'STANDARD',
                trainingCoveragePreset: 'ALL_CONFIRMED',
                trainingGradingTolerance: 'PRACTICAL',
            },
        });

        expect(() =>
            backgroundAnalysis.enqueueGameDbIdsWithOptions(
                'user-a',
                ['game-b'],
                {
                    analysisDefaults: {
                        analysisQuality: 'THOROUGH',
                        trainingCoveragePreset: 'ALL_CONFIRMED',
                        trainingGradingTolerance: 'PRACTICAL',
                    },
                }
            )
        ).toThrow(/already running with different settings/i);
        backgroundAnalysis.setOwner(null);
    });

    it('deduplicates work across both the queued and active run', () => {
        vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)));
        backgroundAnalysis.setOwner('user-a');

        expect(
            backgroundAnalysis.enqueueGameDbIds('user-a', [
                'game-a',
                'game-a',
            ])
        ).toEqual({ acceptedIds: ['game-a'], skippedIds: [] });
        expect(
            backgroundAnalysis.enqueueGameDbIds('user-a', [
                'game-a',
                'game-b',
            ])
        ).toEqual({
            acceptedIds: ['game-b'],
            skippedIds: ['game-a'],
        });

        backgroundAnalysis.setOwner(null);
    });

    it('isolates a superseded owner run from the new owner queue and counters', async () => {
        let resolveOwnerAPreferences!: (response: Response) => void;
        let resolveOwnerBPreferences!: (response: Response) => void;
        const ownerAPreferences = new Promise<Response>((resolve) => {
            resolveOwnerAPreferences = resolve;
        });
        const ownerBPreferences = new Promise<Response>((resolve) => {
            resolveOwnerBPreferences = resolve;
        });
        let preferenceRequests = 0;
        const requestedUrls: string[] = [];
        const fetchMock = vi.fn((input: string | URL | Request) => {
            const url = String(input);
            requestedUrls.push(url);
            if (url === '/api/user/preferences') {
                preferenceRequests += 1;
                return preferenceRequests === 1
                    ? ownerAPreferences
                    : ownerBPreferences;
            }
            throw new Error(`Unexpected request from stale run: ${url}`);
        });
        vi.stubGlobal('fetch', fetchMock);

        backgroundAnalysis.setOwner('user-a');
        backgroundAnalysis.enqueueGameDbIds('user-a', ['game-a']);
        backgroundAnalysis.setOwner('user-b');
        backgroundAnalysis.enqueueGameDbIds('user-b', ['game-b']);

        expect(backgroundAnalysis.snapshot()).toMatchObject({
            ownerId: 'user-b',
            state: 'running',
            totalGames: 1,
            completedGames: 0,
            queuedGames: 1,
            label: '',
        });

        resolveOwnerAPreferences(
            new Response(
                JSON.stringify({ preferences: { analysisQuality: 'STANDARD' } }),
                {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }
            )
        );
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(requestedUrls).not.toContain('/api/games/game-b');
        expect(backgroundAnalysis.snapshot()).toMatchObject({
            ownerId: 'user-b',
            state: 'running',
            totalGames: 1,
            completedGames: 0,
            queuedGames: 1,
            label: '',
        });
        expect(
            backgroundAnalysis.enqueueGameDbIds('user-b', ['game-b'])
        ).toEqual({ acceptedIds: [], skippedIds: ['game-b'] });
        expect(readLastAnalysisCompletion('user-a')).toBeNull();
        expect(readLastAnalysisCompletion('user-b')).toBeNull();

        backgroundAnalysis.setOwner(null);
        resolveOwnerBPreferences(
            new Response(
                JSON.stringify({ preferences: { analysisQuality: 'STANDARD' } }),
                {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }
            )
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
    });

    it('starts a fresh run when work is enqueued after cancelling an active run', async () => {
        let resolveCancelledPreferences!: (response: Response) => void;
        let resolveFreshPreferences!: (response: Response) => void;
        const cancelledPreferences = new Promise<Response>((resolve) => {
            resolveCancelledPreferences = resolve;
        });
        const freshPreferences = new Promise<Response>((resolve) => {
            resolveFreshPreferences = resolve;
        });
        let preferenceRequests = 0;
        const requestedUrls: string[] = [];
        vi.stubGlobal(
            'fetch',
            vi.fn((input: string | URL | Request) => {
                const url = String(input);
                requestedUrls.push(url);
                if (url === '/api/user/preferences') {
                    preferenceRequests += 1;
                    return preferenceRequests === 1
                        ? cancelledPreferences
                        : freshPreferences;
                }
                throw new Error(`Unexpected request: ${url}`);
            })
        );

        backgroundAnalysis.setOwner('user-a');
        backgroundAnalysis.enqueueGameDbIds('user-a', ['cancelled-game']);
        backgroundAnalysis.cancel('user-a');
        expect(
            backgroundAnalysis.enqueueGameDbIds('user-a', ['fresh-game'])
        ).toEqual({ acceptedIds: ['fresh-game'], skippedIds: [] });

        resolveCancelledPreferences(
            new Response(
                JSON.stringify({ preferences: { analysisQuality: 'STANDARD' } }),
                {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }
            )
        );
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(requestedUrls).not.toContain('/api/games/fresh-game');
        expect(backgroundAnalysis.snapshot()).toMatchObject({
            ownerId: 'user-a',
            state: 'running',
            totalGames: 1,
            completedGames: 0,
            queuedGames: 1,
            label: '',
        });
        expect(
            backgroundAnalysis.enqueueGameDbIds('user-a', ['fresh-game'])
        ).toEqual({ acceptedIds: [], skippedIds: ['fresh-game'] });

        backgroundAnalysis.setOwner(null);
        resolveFreshPreferences(
            new Response(
                JSON.stringify({ preferences: { analysisQuality: 'STANDARD' } }),
                {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }
            )
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
    });

    it('ignores a failed pending-count request from an older same-owner generation', async () => {
        let rejectOldRequest!: (reason?: unknown) => void;
        const oldRequest = new Promise<Response>((_resolve, reject) => {
            rejectOldRequest = reject;
        });
        let requests = 0;
        vi.stubGlobal(
            'fetch',
            vi.fn(() => {
                requests += 1;
                return requests === 1
                    ? oldRequest
                    : Promise.resolve(
                          new Response(JSON.stringify({ total: 7 }), {
                              status: 200,
                              headers: { 'Content-Type': 'application/json' },
                          })
                      );
            })
        );

        backgroundAnalysis.setOwner('user-a');
        const staleRefresh = backgroundAnalysis.refreshPendingUnanalyzedCount(
            'user-a'
        );
        backgroundAnalysis.setOwner('user-b');
        backgroundAnalysis.setOwner('user-a');
        await expect(
            backgroundAnalysis.refreshPendingUnanalyzedCount('user-a')
        ).resolves.toBe(7);

        rejectOldRequest(new Error('old request failed'));
        await expect(staleRefresh).resolves.toBeNull();
        expect(backgroundAnalysis.snapshot().pendingUnanalyzedCount).toBe(7);

        backgroundAnalysis.setOwner(null);
    });

    it('cancels and terminates the engine after a normal completed run', async () => {
        const gameDbId = 'engine-complete';
        const externalId = 'external-complete';
        stubBrowserAnalysisApi(gameDbId, externalId);
        engineHarness.extract.mockResolvedValue(
            browserExtractionResult(gameDbId, externalId)
        );

        backgroundAnalysis.setOwner('user-a');
        backgroundAnalysis.enqueueGameDbIds('user-a', [gameDbId]);
        await vi.waitFor(() => {
            expect(backgroundAnalysis.snapshot()).toMatchObject({
                state: 'idle',
                lastError: null,
            });
            expect(engineHarness.instances).toHaveLength(1);
        });

        const engine = engineHarness.instances[0]!;
        expect(engine.cancelAll).toHaveBeenCalledTimes(1);
        expect(engine.terminate).toHaveBeenCalledTimes(1);
        backgroundAnalysis.setOwner(null);
    });

    it('cancels and terminates the engine exactly once when a run is cancelled', async () => {
        const gameDbId = 'engine-cancel';
        const externalId = 'external-cancel';
        let resolveExtraction!: (value: unknown) => void;
        const extraction = new Promise((resolve) => {
            resolveExtraction = resolve;
        });
        stubBrowserAnalysisApi(gameDbId, externalId);
        engineHarness.extract.mockReturnValue(extraction);

        backgroundAnalysis.setOwner('user-a');
        backgroundAnalysis.enqueueGameDbIds('user-a', [gameDbId]);
        await vi.waitFor(() => {
            expect(engineHarness.instances).toHaveLength(1);
            expect(engineHarness.extract).toHaveBeenCalledTimes(1);
        });
        const engine = engineHarness.instances[0]!;

        backgroundAnalysis.cancel('user-a');
        expect(engine.cancelAll).toHaveBeenCalledTimes(1);
        expect(engine.terminate).toHaveBeenCalledTimes(1);

        resolveExtraction(browserExtractionResult(gameDbId, externalId));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(engine.cancelAll).toHaveBeenCalledTimes(1);
        expect(engine.terminate).toHaveBeenCalledTimes(1);
        backgroundAnalysis.setOwner(null);
    });

    it('cancels and terminates the old engine exactly once on owner switch', async () => {
        const gameDbId = 'engine-owner-switch';
        const externalId = 'external-owner-switch';
        let resolveExtraction!: (value: unknown) => void;
        const extraction = new Promise((resolve) => {
            resolveExtraction = resolve;
        });
        stubBrowserAnalysisApi(gameDbId, externalId);
        engineHarness.extract.mockReturnValue(extraction);

        backgroundAnalysis.setOwner('user-a');
        backgroundAnalysis.enqueueGameDbIds('user-a', [gameDbId]);
        await vi.waitFor(() => {
            expect(engineHarness.instances).toHaveLength(1);
            expect(engineHarness.extract).toHaveBeenCalledTimes(1);
        });
        const engine = engineHarness.instances[0]!;

        backgroundAnalysis.setOwner('user-b');
        expect(engine.cancelAll).toHaveBeenCalledTimes(1);
        expect(engine.terminate).toHaveBeenCalledTimes(1);

        resolveExtraction(browserExtractionResult(gameDbId, externalId));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(engine.cancelAll).toHaveBeenCalledTimes(1);
        expect(engine.terminate).toHaveBeenCalledTimes(1);
        backgroundAnalysis.setOwner(null);
    });
});
