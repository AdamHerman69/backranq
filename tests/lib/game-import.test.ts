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
        prismaMock.analyzedGame.findMany.mockResolvedValue([]);
        prismaMock.analyzedGame.createMany.mockResolvedValue({ count: 1 });
    });

    it('snapshots provider identity, side, exact clock, and source hash on create', async () => {
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
            newGameDbIds: [expect.any(String)],
        });
        expect(prismaMock.analyzedGame.createMany).toHaveBeenCalledWith({
            data: [
                expect.objectContaining({
                    id: expect.any(String),
                    sourcePgnHash: hashSourcePgn(originalPgn),
                    sourceUsername: 'Ada',
                    sourceAccountId: 'lichess-account-1',
                    userSide: 'WHITE',
                    timeControlRaw: '600+5',
                    timeControlInitialSeconds: 600,
                    timeControlIncrementSeconds: 5,
                }),
            ],
            skipDuplicates: true,
        });
    });

    it('performs no write when the stored provider snapshot is unchanged', async () => {
        prismaMock.analyzedGame.findMany.mockResolvedValue([{
            id: 'db-game-1',
            provider: 'LICHESS',
            externalId: 'game-1',
            url: null,
            pgn: originalPgn,
            sourcePgnHash: hashSourcePgn(originalPgn),
            sourceUsername: 'Ada',
            sourceAccountId: 'lichess-account-1',
            userSide: 'WHITE',
        }]);
        const { saveNormalizedGamesForUser } =
            await importGameImport();

        await saveNormalizedGamesForUser({
            userId: 'user-1',
            games: [game()],
        });

        expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
        expect(prismaMock.analyzedGame.createMany).not.toHaveBeenCalled();
        expect(
            prismaMock.trainingMoment.updateMany
        ).not.toHaveBeenCalled();
    });

    it('atomically clears analysis provenance and invalidates Positions for a changed PGN', async () => {
        prismaMock.analyzedGame.findMany.mockResolvedValue([{
            id: 'db-game-1',
            provider: 'LICHESS',
            externalId: 'game-1',
            url: null,
            pgn: originalPgn,
            sourcePgnHash: hashSourcePgn(originalPgn),
            sourceUsername: 'Ada',
            sourceAccountId: 'lichess-account-1',
            userSide: 'WHITE',
        }]);
        prismaMock.$queryRaw.mockResolvedValue([{ id: 'db-game-1' }]);
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
        const update = prismaMock.$queryRaw.mock.calls[0]?.[0] as {
            text?: string;
            values?: unknown[];
        };
        expect(update.text).toContain('UPDATE "AnalyzedGame"');
        expect(update.text).toContain('"currentAnalysisValid" = FALSE');
        expect(update.values).toEqual(
            expect.arrayContaining([
                'db-game-1',
                originalPgn,
                correctedPgn,
                hashSourcePgn(correctedPgn),
            ])
        );
        expect(
            prismaMock.trainingMoment.updateMany
        ).toHaveBeenCalledWith({
            where: {
                gameId: { in: ['db-game-1'] },
                userId: 'user-1',
                archivedAt: null,
            },
            data: {
                status: 'INVALIDATED',
                archivedAt: expect.any(Date),
            },
        });
        expect(prismaMock.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
            prismaMock.trainingMoment.updateMany.mock
                .invocationCallOrder[0]!
        );
    });

    it('rejects a duplicate replay from the opposite side without mutating the snapshot', async () => {
        prismaMock.analyzedGame.findMany.mockResolvedValue([{
            id: 'db-game-1',
            provider: 'LICHESS',
            externalId: 'game-1',
            url: null,
            pgn: originalPgn,
            sourcePgnHash: hashSourcePgn(originalPgn),
            sourceUsername: 'Ada',
            sourceAccountId: 'lichess-account-1',
            userSide: 'WHITE',
        }]);
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
        expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
        expect(prismaMock.trainingMoment.updateMany).not.toHaveBeenCalled();
    });

    it('keeps the frozen perspective when an account is unlinked and relinked', async () => {
        prismaMock.analyzedGame.findMany.mockResolvedValue([{
            id: 'db-game-1',
            provider: 'LICHESS',
            externalId: 'game-1',
            url: null,
            pgn: originalPgn,
            sourcePgnHash: hashSourcePgn(originalPgn),
            sourceUsername: 'Ada',
            sourceAccountId: 'lichess-account-1',
            userSide: 'WHITE',
        }]);
        const replayAfterRelink = game();
        // A durable source account can be disconnected and recreated. The game
        // snapshot remains authoritative and is never derived from that row.
        const { saveNormalizedGamesForUser } = await importGameImport();
        await saveNormalizedGamesForUser({
            userId: 'user-1',
            games: [replayAfterRelink],
        });

        expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
    });

    it('does not rewrite a completed Coach snapshot for the same session identity', async () => {
        prismaMock.analyzedGame.findMany.mockResolvedValue([{
            id: 'db-coach-1',
            provider: 'BACKRANQ_COACH',
            externalId: 'session-hash',
            url: null,
            pgn: originalPgn,
            sourcePgnHash: hashSourcePgn(originalPgn),
            sourceUsername: 'Ada',
            sourceAccountId: null,
            userSide: 'WHITE',
        }]);
        const coachGame: NormalizedGame = {
            ...game(correctedPgn),
            id: 'backranq_coach:session-hash',
            provider: 'backranq_coach',
            provenance: {
                username: 'Ada',
                userSide: 'white',
            },
        };
        const { saveNormalizedGamesForUser } = await importGameImport();

        const result = await saveNormalizedGamesForUser({
            userId: 'user-1',
            games: [coachGame],
        });

        expect(result.errors).toMatchObject([
            { code: 'SOURCE_SNAPSHOT_CONFLICT' },
        ]);
        expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
    });

    it('replays a large unchanged batch with one read and zero writes', async () => {
        const games = Array.from({ length: 200 }, (_, index) => ({
            ...game(),
            id: `lichess:game-${index}`,
        }));
        prismaMock.analyzedGame.findMany.mockResolvedValue(
            games.map((item, index) => ({
                id: `db-game-${index}`,
                provider: 'LICHESS',
                externalId: `game-${index}`,
                url: null,
                pgn: item.pgn,
                sourcePgnHash: hashSourcePgn(item.pgn),
                sourceUsername: 'Ada',
                sourceAccountId: 'lichess-account-1',
                userSide: 'WHITE',
            }))
        );
        const { saveNormalizedGamesForUser } = await importGameImport();

        const result = await saveNormalizedGamesForUser({
            userId: 'user-1',
            games,
        });

        expect(result).toMatchObject({
            saved: 200,
            created: 0,
            updated: 0,
            errors: [],
        });
        expect(prismaMock.analyzedGame.findMany).toHaveBeenCalledOnce();
        expect(prismaMock.analyzedGame.createMany).not.toHaveBeenCalled();
        expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
        expect(prismaMock.trainingMoment.updateMany).not.toHaveBeenCalled();
    });
});
