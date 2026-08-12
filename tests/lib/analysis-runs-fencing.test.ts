import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hashSourcePgn } from '@/lib/chess/pgn';
import { mockPrismaModule, prismaMock } from '../helpers/route-mocks';

const replaceTrainingMomentsMock = vi.fn();

async function importRuns() {
    vi.resetModules();
    mockPrismaModule();
    prismaMock.$transaction.mockImplementation(
        async (callback: unknown) =>
            (callback as (tx: typeof prismaMock) => Promise<unknown>)(
                prismaMock
            )
    );
    vi.doMock('@/lib/api/trainingMomentPersistence', () => ({
        replaceTrainingMomentsInTransaction: replaceTrainingMomentsMock,
    }));
    return import('@/lib/services/analysisRuns');
}

describe('analysis completion fencing', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('rejects a stale worker before writing analysis or training moments', async () => {
        const runs = await importRuns();
        const lockedAt = new Date('2026-07-05T12:00:00Z');
        prismaMock.analysisJob.updateMany.mockResolvedValue({ count: 0 });

        await expect(
            runs.completeAnalysisRunWithGameAnalysis({
                runId: 'run-1',
                userId: 'user-1',
                gameId: 'game-1',
                analysis: {
                    accuracy: { white: null, black: null },
                    moves: [],
                    phases: [],
                    openings: [],
                    summary: {
                        white: {},
                        black: {},
                    },
                } as never,
                trainingMoments: [],
                extractionManifest: {
                    version: 1,
                    complete: true,
                    sourceGameId: 'game-1',
                    sourcePgnHash: 'hash',
                    scannedPlies: 0,
                    expectedPlies: 0,
                    termination: 'COMPLETED',
                    errors: [],
                },
                analysisJob: {
                    id: 'job-1',
                    fence: { lockedAt, dispatchedCount: 2 },
                },
            })
        ).rejects.toThrow(/stale-worker fence/i);

        expect(prismaMock.analyzedGame.updateMany).not.toHaveBeenCalled();
        expect(replaceTrainingMomentsMock).not.toHaveBeenCalled();
        expect(prismaMock.$transaction).toHaveBeenCalledWith(
            expect.any(Function),
            runs.ANALYSIS_PERSISTENCE_TRANSACTION_OPTIONS
        );
    });

    it('atomically removes a continuation checkpoint on no-write completion', async () => {
        const runs = await importRuns();
        const lockedAt = new Date('2026-07-05T12:00:00Z');
        prismaMock.analysisJob.updateMany.mockResolvedValue({ count: 1 });
        prismaMock.analysisRun.findFirst.mockResolvedValue({
            id: 'run-1',
            startedAt: new Date('2026-07-05T11:59:00Z'),
        });
        prismaMock.analysisRun.updateMany.mockResolvedValue({ count: 1 });
        prismaMock.analysisRunCheckpoint.deleteMany.mockResolvedValue({
            count: 1,
        });

        await runs.completeAnalysisRunWithoutGameWrite({
            runId: 'run-1',
            analysisJobId: 'job-1',
            fence: { lockedAt, dispatchedCount: 2 },
            consumedCredits: 0,
        });

        expect(prismaMock.analysisRunCheckpoint.deleteMany).toHaveBeenCalledWith(
            { where: { runId: 'run-1' } }
        );
    });

    it('rejects completion when the stored PGN changed after the run started', async () => {
        const runs = await importRuns();
        prismaMock.analysisRun.findFirst.mockResolvedValue({
            id: 'run-1',
            userId: 'user-1',
            gameId: 'game-1',
            configHash: 'config-1',
            inputPgnHash: hashSourcePgn('[Event "Original"]\n\n1. e4 *'),
            startedAt: new Date('2026-07-05T12:00:00Z'),
        });
        prismaMock.analyzedGame.findFirst.mockResolvedValue({
            id: 'game-1',
            pgn: '[Event "Changed"]\n\n1. d4 *',
        });

        await expect(
            runs.completeAnalysisRunWithGameAnalysis({
                runId: 'run-1',
                analysis: {
                    accuracy: { white: null, black: null },
                    moves: [],
                    phases: [],
                    openings: [],
                    summary: { white: {}, black: {} },
                } as never,
                trainingMoments: [],
                extractionManifest: {
                    version: 1,
                    complete: true,
                    sourceGameId: 'game-1',
                    sourcePgnHash: hashSourcePgn(
                        '[Event "Original"]\n\n1. e4 *'
                    ),
                    scannedPlies: 0,
                    expectedPlies: 0,
                    termination: 'COMPLETED',
                    errors: [],
                },
            })
        ).rejects.toThrow(/source pgn changed/i);

        expect(prismaMock.analyzedGame.updateMany).not.toHaveBeenCalled();
        expect(replaceTrainingMomentsMock).not.toHaveBeenCalled();
        expect(prismaMock.analysisRun.updateMany).not.toHaveBeenCalled();
    });

    it('does not mark the run succeeded when canonical persistence fails late', async () => {
        const runs = await importRuns();
        const pgn = '[Event "Stable"]\n\n1. e4 *';
        prismaMock.analysisRun.findFirst.mockResolvedValue({
            id: 'run-1',
            userId: 'user-1',
            gameId: 'game-1',
            configHash: 'config-1',
            inputPgnHash: hashSourcePgn(pgn),
            startedAt: new Date('2026-07-05T12:00:00Z'),
        });
        prismaMock.analyzedGame.findFirst.mockResolvedValue({
            id: 'game-1',
            pgn,
            provider: 'LICHESS',
            playedAt: new Date('2026-07-05T11:00:00Z'),
        });
        prismaMock.analyzedGame.updateMany.mockResolvedValue({ count: 1 });
        prismaMock.analyzedGame.findUniqueOrThrow.mockResolvedValue({
            id: 'game-1',
            analyzedAt: new Date('2026-07-05T12:01:00Z'),
            currentAnalysisRunId: 'run-1',
        });
        replaceTrainingMomentsMock.mockRejectedValue(
            new Error('revision write failed')
        );

        await expect(
            runs.completeAnalysisRunWithGameAnalysis({
                runId: 'run-1',
                analysis: {
                    accuracy: { white: null, black: null },
                    moves: [],
                    phases: [],
                    openings: [],
                    summary: { white: {}, black: {} },
                } as never,
                trainingMoments: [],
                extractionManifest: {
                    version: 1,
                    complete: true,
                    sourceGameId: 'game-1',
                    sourcePgnHash: hashSourcePgn(pgn),
                    scannedPlies: 0,
                    expectedPlies: 0,
                    termination: 'COMPLETED',
                    errors: [],
                },
            })
        ).rejects.toThrow(/revision write failed/i);

        expect(prismaMock.analyzedGame.updateMany).toHaveBeenCalledTimes(1);
        expect(prismaMock.analysisRun.updateMany).not.toHaveBeenCalled();
    });

    it('rejects incomplete extraction before writing game analysis', async () => {
        const runs = await importRuns();
        const pgn = '[Event "Stable"]\n\n1. e4 *';
        const sourcePgnHash = hashSourcePgn(pgn);
        prismaMock.analysisRun.findFirst.mockResolvedValue({
            id: 'run-1',
            userId: 'user-1',
            gameId: 'game-1',
            configHash: 'config-1',
            inputPgnHash: sourcePgnHash,
            startedAt: new Date('2026-07-05T12:00:00Z'),
        });
        prismaMock.analyzedGame.findFirst.mockResolvedValue({
            id: 'game-1',
            pgn,
            provider: 'LICHESS',
            playedAt: new Date('2026-07-05T11:00:00Z'),
        });

        await expect(
            runs.completeAnalysisRunWithGameAnalysis({
                runId: 'run-1',
                analysis: { moves: [] } as never,
                trainingMoments: [],
                extractionManifest: {
                    version: 1,
                    complete: false,
                    sourceGameId: 'game-1',
                    sourcePgnHash,
                    scannedPlies: 0,
                    expectedPlies: 1,
                    termination: 'SOURCE_REPLAY_STOPPED',
                    errors: ['source replay stopped'],
                },
            })
        ).rejects.toThrow(/complete extraction manifest/i);

        expect(prismaMock.analyzedGame.updateMany).not.toHaveBeenCalled();
        expect(replaceTrainingMomentsMock).not.toHaveBeenCalled();
        expect(prismaMock.analysisRun.updateMany).not.toHaveBeenCalled();
    });

    it('derives config and source hashes instead of trusting callers', async () => {
        const runs = await importRuns();
        const pgn = '[Event "Source"]\n\n1. e4 *';
        prismaMock.analyzedGame.findFirst.mockResolvedValue({ pgn });
        prismaMock.analysisRun.create.mockImplementation(
            async (args: unknown) => {
                const data = (args as { data: Record<string, unknown> }).data;
                return { id: 'run-1', ...data };
            }
        );

        await runs.createAnalysisRun({
            userId: 'user-1',
            gameId: 'game-1',
            executionMode: 'LOCAL_BROWSER',
            configSnapshot: { depth: 20, nodes: 50_000 },
        });

        expect(prismaMock.analysisRun.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                inputPgnHash: hashSourcePgn(pgn),
                configHash: runs.hashAnalysisConfig({
                    depth: 20,
                    nodes: 50_000,
                }),
            }),
        });
        expect(prismaMock.analyzedGame.findFirst).toHaveBeenCalledWith({
            where: { id: 'game-1', userId: 'user-1' },
            select: { pgn: true },
        });
    });

    it('rejects a supplied config hash that does not match the snapshot', async () => {
        const runs = await importRuns();

        await expect(
            runs.createAnalysisRun({
                userId: 'user-1',
                gameId: 'game-1',
                executionMode: 'LOCAL_BROWSER',
                configSnapshot: { depth: 20 },
                configHash: 'caller-controlled-hash',
            })
        ).rejects.toThrow(runs.AnalysisConfigHashMismatchError);

        expect(prismaMock.analyzedGame.findFirst).not.toHaveBeenCalled();
        expect(prismaMock.analysisRun.create).not.toHaveBeenCalled();
    });

    it('allows only the monotonic QUEUED to RUNNING transition', async () => {
        const runs = await importRuns();
        prismaMock.analysisRun.updateMany.mockResolvedValue({
            count: 0,
        });

        await expect(
            runs.markAnalysisRunRunning({
                runId: 'run-1',
                userId: 'user-1',
                gameId: 'game-1',
            })
        ).rejects.toThrow(/not queued or current/i);

        expect(prismaMock.analysisRun.updateMany).toHaveBeenCalledWith({
            where: {
                id: 'run-1',
                status: 'QUEUED',
                userId: 'user-1',
                gameId: 'game-1',
            },
            data: expect.objectContaining({ status: 'RUNNING' }),
        });
        expect(
            prismaMock.analysisRun.findUniqueOrThrow
        ).not.toHaveBeenCalled();
    });

    it('cannot overwrite a terminal analysis run with FAILED', async () => {
        const runs = await importRuns();
        prismaMock.analysisRun.findFirst.mockResolvedValue({
            id: 'run-1',
            startedAt: new Date('2026-07-05T12:00:00Z'),
        });
        prismaMock.analysisRun.updateMany.mockResolvedValue({
            count: 0,
        });

        await expect(
            runs.markAnalysisRunFailed({
                runId: 'run-1',
                error: new Error('late worker'),
                completedAt: new Date(
                    '2026-07-05T12:01:00Z'
                ),
            })
        ).rejects.toThrow(/already terminal/i);

        expect(prismaMock.analysisRun.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: {
                    id: 'run-1',
                    status: { in: ['QUEUED', 'RUNNING'] },
                },
                data: expect.objectContaining({ status: 'FAILED' }),
            })
        );
    });

    it('uses the exact PGN as a compare-and-swap completion condition', async () => {
        const runs = await importRuns();
        const pgn = '[Event "Stable"]\n\n1. e4 *';
        prismaMock.analysisRun.findFirst.mockResolvedValue({
            id: 'run-1',
            userId: 'user-1',
            gameId: 'game-1',
            configHash: 'config-1',
            inputPgnHash: hashSourcePgn(pgn),
            startedAt: new Date('2026-07-05T12:00:00Z'),
        });
        prismaMock.analyzedGame.findFirst.mockResolvedValue({
            id: 'game-1',
            pgn,
        });
        prismaMock.analyzedGame.updateMany.mockResolvedValue({ count: 0 });

        await expect(
            runs.completeAnalysisRunWithGameAnalysis({
                runId: 'run-1',
                analysis: { moves: [] } as never,
                trainingMoments: [],
                extractionManifest: {
                    version: 1,
                    complete: true,
                    sourceGameId: 'game-1',
                    sourcePgnHash: hashSourcePgn(pgn),
                    scannedPlies: 0,
                    expectedPlies: 0,
                    termination: 'COMPLETED',
                    errors: [],
                },
            })
        ).rejects.toThrow(runs.SourcePgnChangedError);

        expect(prismaMock.analyzedGame.updateMany).toHaveBeenCalledWith({
            where: { id: 'game-1', pgn },
            data: expect.objectContaining({
                currentAnalysisRunId: 'run-1',
            }),
        });
        expect(replaceTrainingMomentsMock).not.toHaveBeenCalled();
    });
});
