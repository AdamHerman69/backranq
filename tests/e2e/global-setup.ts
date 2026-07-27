import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { PrismaClient, type Prisma } from '@prisma/client';
import type { FullConfig } from '@playwright/test';

import { assertSafeE2eDatabaseConfig } from '../../scripts/lib/e2e-database-safety.mjs';
import {
    E2E_AUTH_STATE_PATH,
    E2E_GAMES,
    E2E_PUZZLES,
    E2E_USER,
} from './support/fixtures';

const STANDARD_FEN =
    'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -';
const PROMOTION_FEN = '7k/P7/8/8/8/8/8/7K w - - 0 1';

function assertSafeE2eDatabase() {
    const databaseUrl = process.env.DATABASE_URL;
    assertSafeE2eDatabaseConfig({
        useExternalDatabase:
            process.env.BACKRANQ_E2E_DATABASE_MODE === 'external',
        databaseUrl,
        directUrl: process.env.DIRECT_URL ?? databaseUrl,
        environment: process.env,
    });
}

function standardPuzzle(
    id: string,
    halfmoveClock: number,
    label: string
): Prisma.PuzzleCreateManyInput {
    return {
        id,
        userId: E2E_USER.id,
        gameId: E2E_GAMES.standard,
        sourcePly: 2,
        fen: `${STANDARD_FEN} ${halfmoveClock} 2`,
        type: 'PUNISH_BLUNDER',
        kind: 'MISSED_TACTIC',
        phase: 'OPENING',
        severity: 'medium',
        bestMoveUci: 'g1f3',
        acceptedMovesUci: ['g1f3'],
        bestLine: ['g1f3', 'b8c6', 'f1b5'],
        score: { type: 'cp', value: 85 },
        tags: ['development', 'center'],
        openingEco: 'C20',
        openingName: "King's Pawn Game",
        label,
    };
}

async function seedFixtures(prisma: PrismaClient, sessionToken: string) {
    await prisma.user.deleteMany({
        where: {
            OR: [{ id: E2E_USER.id }, { email: E2E_USER.email }],
        },
    });

    await prisma.user.create({
        data: {
            id: E2E_USER.id,
            email: E2E_USER.email,
            name: E2E_USER.name,
            lichessUsername: E2E_USER.username,
            chesscomUsername: E2E_USER.username,
            preferences: {
                trainerContextHintsEnabled: false,
            },
        },
    });

    await prisma.billingAccount.create({
        data: {
            userId: E2E_USER.id,
            plan: 'FREE',
            serverCreditsBalance: 12,
            monthlyServerCreditsLimit: 100,
            monthlyServerCreditsUsed: 7,
            autoAnalysisMonthlyCap: 50,
            autoAnalysisDailyCap: 10,
            stopWhenCreditsBelow: 2,
        },
    });

    await prisma.analyzedGame.createMany({
        data: [
            {
                id: E2E_GAMES.standard,
                userId: E2E_USER.id,
                provider: 'LICHESS',
                externalId: 'backranq-e2e-standard',
                url: 'https://lichess.org/backranq-e2e-standard',
                pgn: `[Event "Backranq E2E"]
[Site "Local"]
[Date "2026.07.20"]
[Round "-"]
[White "E2EHero"]
[Black "TacticalTester"]
[Result "1-0"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 1-0`,
                playedAt: new Date('2026-07-20T12:00:00.000Z'),
                timeClass: 'RAPID',
                rated: true,
                result: '1-0',
                whiteName: E2E_USER.username,
                whiteRating: 1812,
                blackName: 'TacticalTester',
                blackRating: 1794,
                openingEco: 'C20',
                openingName: "King's Pawn Game",
                analysis: {
                    whiteAccuracy: 91.4,
                    blackAccuracy: 84.2,
                },
                analyzedAt: new Date('2026-07-20T12:15:00.000Z'),
            },
            {
                id: E2E_GAMES.promotion,
                userId: E2E_USER.id,
                provider: 'CHESSCOM',
                externalId: 'backranq-e2e-promotion',
                url: 'https://www.chess.com/game/live/backranq-e2e-promotion',
                pgn: `[Event "Backranq E2E Promotion"]
[Site "Local"]
[Date "2026.07.19"]
[Round "-"]
[White "PromotionTester"]
[Black "E2EHero"]
[Result "0-1"]
[SetUp "1"]
[FEN "${PROMOTION_FEN}"]

0-1`,
                playedAt: new Date('2026-07-19T12:00:00.000Z'),
                timeClass: 'BLITZ',
                rated: false,
                result: '0-1',
                whiteName: 'PromotionTester',
                whiteRating: 1701,
                blackName: E2E_USER.username,
                blackRating: 1820,
                openingEco: null,
                openingName: 'Promotion exercise',
                analysis: {},
                analyzedAt: null,
            },
        ],
    });

    await prisma.puzzle.createMany({
        data: [
            standardPuzzle(E2E_PUZZLES.wrongMove, 0, 'Wrong move fixture'),
            standardPuzzle(E2E_PUZZLES.dragMove, 1, 'Drag move fixture'),
            standardPuzzle(E2E_PUZZLES.reveal, 2, 'Reveal fixture'),
            standardPuzzle(E2E_PUZZLES.offline, 3, 'Offline queue fixture'),
            {
                id: E2E_PUZZLES.promotion,
                userId: E2E_USER.id,
                gameId: E2E_GAMES.promotion,
                sourcePly: 0,
                fen: PROMOTION_FEN,
                type: 'AVOID_BLUNDER',
                kind: 'MISSED_WIN',
                phase: 'ENDGAME',
                severity: 'big',
                bestMoveUci: 'a7a8n',
                acceptedMovesUci: ['a7a8n'],
                bestLine: ['a7a8n'],
                score: { type: 'cp', value: 500 },
                tags: ['promotion', 'underpromotion'],
                openingName: 'Promotion exercise',
                label: 'Promotion fixture',
            },
        ],
    });

    await prisma.session.create({
        data: {
            sessionToken,
            userId: E2E_USER.id,
            expires: new Date(Date.now() + 4 * 60 * 60 * 1_000),
        },
    });
}

async function writeAuthState(sessionToken: string, baseURL: string) {
    const url = new URL(baseURL);
    await fs.mkdir(path.dirname(E2E_AUTH_STATE_PATH), { recursive: true });
    await fs.writeFile(
        E2E_AUTH_STATE_PATH,
        JSON.stringify(
            {
                cookies: [
                    {
                        name: 'authjs.session-token',
                        value: sessionToken,
                        domain: url.hostname,
                        path: '/',
                        expires: Math.floor(Date.now() / 1_000) + 4 * 60 * 60,
                        httpOnly: true,
                        secure: url.protocol === 'https:',
                        sameSite: 'Lax',
                    },
                ],
                origins: [],
            },
            null,
            2
        ),
        { mode: 0o600 }
    );
}

export default async function globalSetup(config: FullConfig) {
    assertSafeE2eDatabase();
    const projectBaseURL = config.projects[0]?.use.baseURL;
    const baseURL =
        typeof projectBaseURL === 'string'
            ? projectBaseURL
            : 'http://127.0.0.1:3100';
    const sessionToken = crypto.randomBytes(32).toString('hex');
    const prisma = new PrismaClient();

    try {
        await seedFixtures(prisma, sessionToken);
        await writeAuthState(sessionToken, baseURL);
    } catch (error) {
        await prisma.user.deleteMany({
            where: {
                OR: [{ id: E2E_USER.id }, { email: E2E_USER.email }],
            },
        });
        await fs.rm(E2E_AUTH_STATE_PATH, { force: true });
        throw error;
    } finally {
        await prisma.$disconnect();
    }

    return async () => {
        assertSafeE2eDatabase();
        const cleanupPrisma = new PrismaClient();
        try {
            await cleanupPrisma.user.deleteMany({
                where: {
                    OR: [{ id: E2E_USER.id }, { email: E2E_USER.email }],
                },
            });
        } finally {
            await cleanupPrisma.$disconnect();
            await fs.rm(E2E_AUTH_STATE_PATH, { force: true });
        }
    };
}
