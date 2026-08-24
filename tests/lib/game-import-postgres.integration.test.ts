import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NormalizedGame } from '@/lib/types/game';
import { saveNormalizedGamesForUser } from '@/lib/services/gameImport';

const integration = describe.runIf(
    process.env.BACKRANQ_POSTGRES_INTEGRATION === 'true'
);
const db = new PrismaClient();
const userId = '10000000-0000-4000-8000-000000000051';

function game(args: {
    id: string;
    pgn: string;
    url?: string;
    username?: string;
    userSide?: 'white' | 'black';
}): NormalizedGame {
    return {
        id: `lichess:${args.id}`,
        provider: 'lichess',
        url: args.url,
        playedAt: '2026-08-24T10:00:00.000Z',
        timeClass: 'rapid',
        rated: true,
        result: '1-0',
        white: { name: 'integration-white', rating: 1800 },
        black: { name: 'integration-black', rating: 1750 },
        pgn: args.pgn,
        provenance: {
            username: args.username ?? 'integration-white',
            userSide: args.userSide ?? 'white',
            timeControl: {
                raw: '600+5',
                initialSeconds: 600,
                incrementSeconds: 5,
            },
        },
    };
}

const originalPgn = `[Event "Integration"]
[White "integration-white"]
[Black "integration-black"]
[Result "1-0"]

1. e4 e5 2. Nf3 Nc6 1-0`;

const correctedPgn = `[Event "Integration corrected"]
[White "integration-white"]
[Black "integration-black"]
[Result "1-0"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 1-0`;

async function persist(games: NormalizedGame[], failOnError = true) {
    return db.$transaction((tx) =>
        saveNormalizedGamesForUser({
            userId,
            games,
            client: tx,
            failOnError,
        })
    );
}

integration('set-based game import against PostgreSQL', () => {
    beforeAll(async () => {
        await db.user.deleteMany({ where: { id: userId } });
        await db.user.create({
            data: {
                id: userId,
                email: 'game-import-postgres@backranq.test',
                preferences: {},
            },
        });
    });

    afterAll(async () => {
        await db.user.deleteMany({ where: { id: userId } });
        await db.$disconnect();
    });

    it('batches creates, performs fenced updates, invalidates training, and rejects a strict batch before writes', async () => {
        const first = game({
            id: 'postgres-import-1',
            pgn: originalPgn,
            url: 'https://lichess.org/postgres-import-1',
        });
        const conflictTarget = game({
            id: 'postgres-import-2',
            pgn: originalPgn,
            url: 'https://lichess.org/postgres-import-2',
        });

        const created = await persist([first, conflictTarget]);
        expect(created).toMatchObject({
            saved: 2,
            created: 2,
            updated: 0,
            errors: [],
        });

        const firstId = created.ids[first.id]!;
        const stored = await db.analyzedGame.findUniqueOrThrow({
            where: { id: firstId },
            select: { sourcePgnHash: true },
        });
        await db.analyzedGame.update({
            where: { id: firstId },
            data: {
                analysis: { stale: true },
                analyzedAt: new Date('2026-08-24T10:05:00.000Z'),
            },
        });
        await db.trainingMoment.create({
            data: {
                userId,
                gameId: firstId,
                momentKey: 'postgres-import-moment',
                sourcePgnHash: stored.sourcePgnHash,
                decisionPly: 2,
                fen: '8/8/8/8/8/8/8/K6k w - - 0 1',
                sideToMove: 'w',
                originalMoveUci: 'a1a2',
                scoreBefore: { cp: 20 },
                scoreAfter: { cp: -120 },
                cpLoss: 140,
                status: 'ACTIVE',
                sourceKinds: ['MY_MISTAKE'],
            },
        });

        const corrected = game({
            id: 'postgres-import-1',
            pgn: correctedPgn,
            url: 'https://lichess.org/postgres-import-1-corrected',
        });
        const updated = await persist([corrected]);
        expect(updated).toMatchObject({
            saved: 1,
            created: 0,
            updated: 1,
            errors: [],
        });
        await expect(
            db.analyzedGame.findUniqueOrThrow({
                where: { id: firstId },
                select: {
                    pgn: true,
                    url: true,
                    analysis: true,
                    analyzedAt: true,
                },
            })
        ).resolves.toMatchObject({
            pgn: correctedPgn,
            url: 'https://lichess.org/postgres-import-1-corrected',
            analysis: {},
            analyzedAt: null,
        });
        await expect(
            db.trainingMoment.findFirstOrThrow({
                where: { gameId: firstId },
                select: { status: true, archivedAt: true },
            })
        ).resolves.toMatchObject({
            status: 'INVALIDATED',
            archivedAt: expect.any(Date),
        });

        const beforeReplay = await db.analyzedGame.findUniqueOrThrow({
            where: { id: firstId },
            select: { updatedAt: true },
        });
        const replay = await persist([corrected]);
        expect(replay).toMatchObject({
            saved: 1,
            created: 0,
            updated: 0,
            errors: [],
        });
        await expect(
            db.analyzedGame.findUniqueOrThrow({
                where: { id: firstId },
                select: { updatedAt: true },
            })
        ).resolves.toEqual(beforeReplay);

        const rejectedUrl = 'https://lichess.org/must-not-be-written';
        const strict = await persist([
            { ...corrected, url: rejectedUrl },
            game({
                id: 'postgres-import-2',
                pgn: originalPgn,
                username: 'integration-black',
                userSide: 'black',
            }),
        ]);
        expect(strict.errors).toHaveLength(1);
        expect(strict.errors[0]?.code).toBe('PROVENANCE_CONFLICT');
        await expect(
            db.analyzedGame.findUniqueOrThrow({
                where: { id: firstId },
                select: { url: true },
            })
        ).resolves.toEqual({
            url: 'https://lichess.org/postgres-import-1-corrected',
        });
    });
});
