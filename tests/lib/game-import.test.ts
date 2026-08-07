import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hashSourcePgn } from '@/lib/chess/pgn';
import type { NormalizedGame } from '@/lib/types/game';
import { mockPrismaModule, prismaMock } from '../helpers/route-mocks';

type GameImportModule = typeof import('@/lib/services/gameImport');

const originalPgn =
    '[Event "Import"]\n[Result "1-0"]\n\n1. e4 e5 1-0';
const correctedPgn =
    '[Event "Import"]\n[Result "1-0"]\n\n1. e4 c5 1-0';

function game(pgn = originalPgn): NormalizedGame {
    return {
        id: 'lichess:game-1',
        provider: 'lichess',
        playedAt: '2026-07-30T10:00:00.000Z',
        timeClass: 'rapid',
        rated: true,
        white: { name: 'Ada', rating: 1800 },
        black: { name: 'Grace', rating: 1750 },
        result: '1-0',
        pgn,
        provenance: {
            username: 'Ada',
            accountId: 'lichess-account-1',
            userSide: 'white',
            timeControl: {
                raw: '600+5',
                initialSeconds: 600,
                incrementSeconds: 5,
            },
        },
    };
}

async function importGameImport(): Promise<GameImportModule> {
    vi.resetModules();
    mockPrismaModule();
    return import('@/lib/services/gameImport');
}

describe('game import provenance and PGN invalidation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        prismaMock.$transaction.mockImplementation(
            async (callback: unknown) =>
                (
                    callback as (
                        tx: typeof prismaMock
                    ) => Promise<unknown>
                )(prismaMock)
        );
        prismaMock.trainingMoment.updateMany.mockResolvedValue({
            count: 1,
        });
    });

    it('snapshots provider identity, side, exact clock, and source hash on create', async () => {
        prismaMock.analyzedGame.findUnique.mockResolvedValue(null);
        prismaMock.analyzedGame.create.mockResolvedValue({
            id: 'db-game-1',
        });
        const { saveNormalizedGamesForUser } =
            await importGameImport();

        const result = await saveNormalizedGamesForUser({
            userId: 'user-1',
            games: [game()],
        });

        expect(result).toMatchObject({
            saved: 1,
            created: 1,
            updated: 0,
            newGameDbIds: ['db-game-1'],
        });
        expect(prismaMock.analyzedGame.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                sourcePgnHash: hashSourcePgn(originalPgn),
                sourceUsername: 'Ada',
                sourceAccountId: 'lichess-account-1',
                userSide: 'WHITE',
                timeControlRaw: '600+5',
                timeControlInitialSeconds: 600,
                timeControlIncrementSeconds: 5,
            }),
            select: { id: true },
        });
    });

    it('does not invalidate Positions when the stored PGN is unchanged', async () => {
        prismaMock.analyzedGame.findUnique.mockResolvedValue({
            id: 'db-game-1',
            pgn: originalPgn,
            sourcePgnHash: hashSourcePgn(originalPgn),
            sourceUsername: 'Ada',
            sourceAccountId: 'lichess-account-1',
            userSide: 'WHITE',
        });
        prismaMock.analyzedGame.updateMany.mockResolvedValue({
            count: 1,
        });
        const { saveNormalizedGamesForUser } =
            await importGameImport();

        await saveNormalizedGamesForUser({
            userId: 'user-1',
            games: [game()],
        });

        expect(
            prismaMock.analyzedGame.updateMany
        ).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.not.objectContaining({
                    currentAnalysisRunId: null,
                }),
            })
        );
        expect(
            prismaMock.trainingMoment.updateMany
        ).not.toHaveBeenCalled();
    });

    it('atomically clears analysis provenance and invalidates Positions for a changed PGN', async () => {
        prismaMock.analyzedGame.findUnique.mockResolvedValue({
            id: 'db-game-1',
            pgn: originalPgn,
            sourcePgnHash: hashSourcePgn(originalPgn),
            sourceUsername: 'Ada',
            sourceAccountId: 'lichess-account-1',
            userSide: 'WHITE',
        });
        prismaMock.analyzedGame.updateMany.mockResolvedValue({
            count: 1,
        });
        const { saveNormalizedGamesForUser } =
            await importGameImport();

        const result = await saveNormalizedGamesForUser({
            userId: 'user-1',
            games: [game(correctedPgn)],
        });

        expect(result).toMatchObject({
            saved: 1,
            created: 0,
            updated: 1,
        });
        expect(
            prismaMock.analyzedGame.updateMany
        ).toHaveBeenCalledWith({
            where: {
                id: 'db-game-1',
                userId: 'user-1',
                pgn: originalPgn,
                sourcePgnHash: hashSourcePgn(originalPgn),
            },
            data: expect.objectContaining({
                pgn: correctedPgn,
                sourcePgnHash: hashSourcePgn(correctedPgn),
                analysis: {},
                analyzedAt: null,
                currentAnalysisRunId: null,
            }),
        });
        expect(
            prismaMock.trainingMoment.updateMany
        ).toHaveBeenCalledWith({
            where: {
                gameId: 'db-game-1',
                userId: 'user-1',
                archivedAt: null,
            },
            data: {
                status: 'INVALIDATED',
                archivedAt: expect.any(Date),
            },
        });
        expect(
            prismaMock.analyzedGame.updateMany.mock.invocationCallOrder[0]
        ).toBeLessThan(
            prismaMock.trainingMoment.updateMany.mock
                .invocationCallOrder[0]!
        );
    });

    it('rejects a duplicate replay from the opposite side without mutating the snapshot', async () => {
        prismaMock.analyzedGame.findUnique.mockResolvedValue({
            id: 'db-game-1',
            pgn: originalPgn,
            sourcePgnHash: hashSourcePgn(originalPgn),
            sourceUsername: 'Ada',
            sourceAccountId: 'lichess-account-1',
            userSide: 'WHITE',
        });
        const oppositePerspective = game();
        oppositePerspective.provenance = {
            ...oppositePerspective.provenance!,
            username: 'Grace',
            userSide: 'black',
        };
        const { saveNormalizedGamesForUser } = await importGameImport();

        const result = await saveNormalizedGamesForUser({
            userId: 'user-1',
            games: [oppositePerspective],
        });

        expect(result).toMatchObject({
            saved: 0,
            errors: [{ code: 'PROVENANCE_CONFLICT' }],
        });
        expect(prismaMock.analyzedGame.updateMany).not.toHaveBeenCalled();
        expect(prismaMock.trainingMoment.updateMany).not.toHaveBeenCalled();
    });

    it('keeps the frozen perspective when an account is unlinked and relinked', async () => {
        prismaMock.analyzedGame.findUnique.mockResolvedValue({
            id: 'db-game-1',
            pgn: originalPgn,
            sourcePgnHash: hashSourcePgn(originalPgn),
            sourceUsername: 'Ada',
            sourceAccountId: 'lichess-account-1',
            userSide: 'WHITE',
        });
        prismaMock.analyzedGame.updateMany.mockResolvedValue({ count: 1 });
        const replayAfterRelink = game();
        // A durable source account can be disconnected and recreated. The game
        // snapshot remains authoritative and is never derived from that row.
        const { saveNormalizedGamesForUser } = await importGameImport();
        await saveNormalizedGamesForUser({
            userId: 'user-1',
            games: [replayAfterRelink],
        });

        expect(prismaMock.analyzedGame.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.not.objectContaining({
                    sourceUsername: expect.anything(),
                    sourceAccountId: expect.anything(),
                    userSide: expect.anything(),
                }),
            })
        );
    });
});
