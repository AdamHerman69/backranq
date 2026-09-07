import { practicePositionFixture } from '../helpers/practice-position';
import { originalDecisionForPracticeManifest } from '../../src/lib/training/practiceSourceBinding';
import { DEFAULT_ASSESSMENT_POLICY } from '../../src/lib/training/practiceContract';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { PrismaClient } from '@prisma/client';
import type { FullConfig } from '@playwright/test';

import { assertSafeE2eDatabaseConfig } from '../../scripts/lib/e2e-database-safety.mjs';
import { countSourcePgnPlies, hashSourcePgn } from '../../src/lib/chess/pgn';
import {
    E2E_AUTH_STATE_PATH,
    E2E_GAMES,
    E2E_TRAINING_MOMENTS,
    E2E_USER,
} from './support/fixtures';

const STANDARD_FEN =
    'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -';
const PROMOTION_FEN = '7k/P7/8/8/8/8/8/7K w - - 0 1';
const E2E_ANALYSIS_RUNS = {
    standard: '30000000-0000-4000-8000-00000000e2e1',
    promotion: '30000000-0000-4000-8000-00000000e2e2',
} as const;
const E2E_SOLUTION_REVISIONS = {
    wrongMove: '40000000-0000-4000-8000-00000000e2e1',
    dragMove: '40000000-0000-4000-8000-00000000e2e2',
    reveal: '40000000-0000-4000-8000-00000000e2e3',
    offline: '40000000-0000-4000-8000-00000000e2e4',
    promotion: '40000000-0000-4000-8000-00000000e2e5',
} as const;
const E2E_PREMIUM_INVITATION = {
    id: '60000000-0000-4000-8000-00000000e2e1',
    email: 'invited-friend@example.com',
    activeKey: 'e2e:invited-friend@example.com',
} as const;
const STANDARD_PGN = `[Event "Backranq E2E"]
[Site "Local"]
[Date "2026.07.20"]
[Round "-"]
[White "E2EHero"]
[Black "TacticalTester"]
[Result "1-0"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 1-0`;
const PROMOTION_PGN = `[Event "Backranq E2E Promotion"]
[Site "Local"]
[Date "2026.07.19"]
[Round "-"]
[White "PromotionTester"]
[Black "E2EHero"]
[Result "0-1"]
[SetUp "1"]
[FEN "${PROMOTION_FEN}"]

0-1`;
const STANDARD_SOURCE_PGN_HASH = hashSourcePgn(STANDARD_PGN);
const PROMOTION_SOURCE_PGN_HASH = hashSourcePgn(PROMOTION_PGN);
const TRAINING_CONFIG_HASH = 'b'.repeat(64);

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

function standardTrainingMoment({
    id,
    revisionId,
    decisionPly,
    halfmoveClock,
}: {
    id: string;
    revisionId: string;
    decisionPly: number;
    halfmoveClock: number;
}) {
    return {
        id,
        revisionId,
        userId: E2E_USER.id,
        gameId: E2E_GAMES.standard,
        analysisRunId: E2E_ANALYSIS_RUNS.standard,
        decisionPly,
        fen: `${STANDARD_FEN} ${halfmoveClock} 2`,
        sideToMove: 'w' as const,
        originalMoveUci: 'f1c4',
        phase: 'OPENING' as const,
        bestMoveUci: 'g1f3',
        acceptedMovesUci: ['g1f3'] as string[],
        bestLineUci: ['g1f3'] as string[],
        sourceKinds: ['MY_MISTAKE'] as const,
        lessonKinds: ['IMPROVE_POSITION'] as const,
        themes: ['development', 'quiet-move'],
    };
}

const STANDARD_TRAINING_MOMENTS = [
    standardTrainingMoment({
        id: E2E_TRAINING_MOMENTS.wrongMove,
        revisionId: E2E_SOLUTION_REVISIONS.wrongMove,
        decisionPly: 2,
        halfmoveClock: 0,
    }),
    standardTrainingMoment({
        id: E2E_TRAINING_MOMENTS.dragMove,
        revisionId: E2E_SOLUTION_REVISIONS.dragMove,
        decisionPly: 3,
        halfmoveClock: 1,
    }),
    standardTrainingMoment({
        id: E2E_TRAINING_MOMENTS.reveal,
        revisionId: E2E_SOLUTION_REVISIONS.reveal,
        decisionPly: 4,
        halfmoveClock: 2,
    }),
    standardTrainingMoment({
        id: E2E_TRAINING_MOMENTS.offline,
        revisionId: E2E_SOLUTION_REVISIONS.offline,
        decisionPly: 5,
        halfmoveClock: 3,
    }),
] as const;


async function seedTrainingMoment(
    prisma: PrismaClient,
    fixture: (typeof STANDARD_TRAINING_MOMENTS)[number] | {
        id: string;
        revisionId: string;
        userId: string;
        gameId: string;
        analysisRunId: string;
        decisionPly: number;
        fen: string;
        sideToMove: 'w';
        originalMoveUci: string;
        phase: 'ENDGAME';
        bestMoveUci: string;
        acceptedMovesUci: string[];
        bestLineUci: string[];
        sourceKinds: readonly ['MISSED_OPPORTUNITY'];
        lessonKinds: readonly ['CONVERT_ADVANTAGE'];
        themes: string[];
    }
) {
    const manifest = practicePositionFixture({
        fen: fixture.fen, originalMoveUci: fixture.originalMoveUci, bestMoveUci: fixture.bestMoveUci,
        momentId: fixture.id, revisionId: fixture.revisionId, gameId: fixture.gameId,
        sourcePgnHash: fixture.gameId === E2E_GAMES.standard ? STANDARD_SOURCE_PGN_HASH : PROMOTION_SOURCE_PGN_HASH,
        decisionPly: fixture.decisionPly, configHash: TRAINING_CONFIG_HASH,
        ...(fixture.id === E2E_TRAINING_MOMENTS.dragMove ? { continuation: { opponentMoveUci: 'b8c6', userMoveUci: 'f1b5' } } : {}),
    });
    const original = originalDecisionForPracticeManifest(manifest);
    await prisma.trainingMoment.create({ data: {
        id: fixture.id, userId: fixture.userId, gameId: fixture.gameId,
        momentKey: crypto.createHash('sha256').update(`e2e:${fixture.id}`).digest('hex'),
        sourcePgnHash: manifest.source.sourcePgnHash, decisionPly: fixture.decisionPly,
        fen: manifest.source.fen, positionHistory: [], sideToMove: fixture.sideToMove,
        originalMoveUci: fixture.originalMoveUci, ...original,
        confidence: 0.99, phase: fixture.phase, status: 'ACTIVE', sourceKinds: [...fixture.sourceKinds],
        lessonKinds: [...fixture.lessonKinds], themes: fixture.themes,
    } });
    await prisma.solutionRevision.create({ data: {
        id: fixture.revisionId, momentId: fixture.id, analysisRunId: fixture.analysisRunId,
        revision: 1, solutionHash: manifest.semanticHash, trainable: true, manifest,
        generatorVersion: manifest.generatorVersion, configHash: TRAINING_CONFIG_HASH,
    } });
    await prisma.trainingMoment.update({ where: { id: fixture.id }, data: { currentSolutionRevisionId: fixture.revisionId } });
}

async function deleteE2eUserGraph(prisma: PrismaClient) {
    const userWhere = {
        OR: [{ id: E2E_USER.id }, { email: E2E_USER.email }],
    };
    await prisma.trainingAttempt.deleteMany({
        where: { userId: E2E_USER.id },
    });
    await prisma.trainingMoment.updateMany({
        where: { userId: E2E_USER.id },
        data: { currentSolutionRevisionId: null },
    });
    await prisma.solutionRevision.deleteMany({
        where: { moment: { userId: E2E_USER.id } },
    });
    await prisma.trainingMoment.deleteMany({
        where: { userId: E2E_USER.id },
    });
    await prisma.premiumInvitation.deleteMany({
        where: { id: E2E_PREMIUM_INVITATION.id },
    });
    await prisma.user.deleteMany({ where: userWhere });
}

async function seedFixtures(prisma: PrismaClient, sessionToken: string) {
    await deleteE2eUserGraph(prisma);

    await prisma.user.create({
        data: {
            id: E2E_USER.id,
            email: E2E_USER.email,
            name: E2E_USER.name,
            preferences: {
            },
        },
    });

    await prisma.adminMembership.create({
        data: {
            userId: E2E_USER.id,
            role: 'ADMIN',
            active: true,
        },
    });

    await prisma.premiumInvitation.create({
        data: {
            id: E2E_PREMIUM_INVITATION.id,
            email: E2E_PREMIUM_INVITATION.email,
            emailNormalized: E2E_PREMIUM_INVITATION.email,
            activeKey: E2E_PREMIUM_INVITATION.activeKey,
            tokenHash: 'e2e-premium-invitation-token-hash',
            plan: 'PRO',
            invitedById: E2E_USER.id,
            expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1_000),
            deliveryStatus: 'SENT',
            deliveryAttempts: 1,
            lastDeliveryAttemptAt: new Date(),
            emailSentAt: new Date(),
            providerEmailId: 'e2e-message-1',
        },
    });

    await prisma.chessAccountConnection.createMany({
        data: [
            {
                userId: E2E_USER.id,
                provider: 'LICHESS',
                providerAccountId: 'backranq-e2e-lichess',
                username: E2E_USER.username,
                usernameNormalized: E2E_USER.username.toLowerCase(),
                origin: 'PUBLIC_PROFILE',
            },
            {
                userId: E2E_USER.id,
                provider: 'CHESSCOM',
                providerAccountId: 'backranq-e2e-chesscom',
                username: E2E_USER.username,
                usernameNormalized: E2E_USER.username.toLowerCase(),
                origin: 'PUBLIC_PROFILE',
            },
        ],
    });

    await prisma.billingAccount.create({
        data: {
            userId: E2E_USER.id,
            plan: 'FREE',
            serverCreditsBalance: 12,
            monthlyServerCreditsLimit: 100,
            monthlyServerCreditsUsed: 7,
            autoAnalysisMonthlyGameLimit: 50,
            autoAnalysisDailyGameLimit: 10,
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
                pgn: STANDARD_PGN,
                plyCount: countSourcePgnPlies(STANDARD_PGN),
                sourcePgnHash: STANDARD_SOURCE_PGN_HASH,
                sourceUsername: E2E_USER.username,
                userSide: 'WHITE',
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
                    moves: [
                        {
                            ply: 0,
                            san: 'e4',
                            uci: 'e2e4',
                            classification: 'book',
                            evalBefore: null,
                            evalAfter: null,
                            cpLoss: 0,
                        },
                        {
                            ply: 1,
                            san: 'e5',
                            uci: 'e7e5',
                            classification: 'book',
                            evalBefore: null,
                            evalAfter: null,
                            cpLoss: 0,
                        },
                        {
                            ply: 2,
                            san: 'Nf3',
                            uci: 'g1f3',
                            classification: 'best',
                            evalBefore: null,
                            evalAfter: null,
                            cpLoss: 0,
                            hasTrainingMoment: true,
                        },
                        {
                            ply: 3,
                            san: 'Nc6',
                            uci: 'b8c6',
                            classification: 'excellent',
                            evalBefore: null,
                            evalAfter: null,
                            cpLoss: 18,
                        },
                        {
                            ply: 4,
                            san: 'Bb5',
                            uci: 'f1b5',
                            classification: 'great',
                            evalBefore: null,
                            evalAfter: null,
                            cpLoss: 0,
                        },
                        {
                            ply: 5,
                            san: 'a6',
                            uci: 'a7a6',
                            classification: 'inaccuracy',
                            evalBefore: null,
                            evalAfter: null,
                            cpLoss: 74,
                        },
                    ],
                },
                whiteAccuracy: 91.4,
                blackAccuracy: 84.2,
                analyzedAt: new Date('2026-07-20T12:15:00.000Z'),
            },
            {
                id: E2E_GAMES.promotion,
                userId: E2E_USER.id,
                provider: 'CHESSCOM',
                externalId: 'backranq-e2e-promotion',
                url: 'https://www.chess.com/game/live/backranq-e2e-promotion',
                pgn: PROMOTION_PGN,
                plyCount: countSourcePgnPlies(PROMOTION_PGN),
                sourcePgnHash: PROMOTION_SOURCE_PGN_HASH,
                sourceUsername: E2E_USER.username,
                userSide: 'BLACK',
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

    await prisma.analysisRun.createMany({
        data: [
            {
                id: E2E_ANALYSIS_RUNS.standard,
                userId: E2E_USER.id,
                gameId: E2E_GAMES.standard,
                executionMode: 'LOCAL_BROWSER',
                analysisQuality: 'THOROUGH',
                creditCost: 0,
                status: 'SUCCEEDED',
                inputPgnHash: STANDARD_SOURCE_PGN_HASH,
                configHash: TRAINING_CONFIG_HASH,
                configSnapshot: { extractor: { confirmNodes: 100_000, gradingPolicy: DEFAULT_ASSESSMENT_POLICY } },
                completedAt: new Date('2026-07-20T12:15:00.000Z'),
            },
            {
                id: E2E_ANALYSIS_RUNS.promotion,
                userId: E2E_USER.id,
                gameId: E2E_GAMES.promotion,
                executionMode: 'LOCAL_BROWSER',
                analysisQuality: 'THOROUGH',
                creditCost: 0,
                status: 'SUCCEEDED',
                inputPgnHash: PROMOTION_SOURCE_PGN_HASH,
                configHash: TRAINING_CONFIG_HASH,
                configSnapshot: { extractor: { confirmNodes: 100_000, gradingPolicy: DEFAULT_ASSESSMENT_POLICY } },
                completedAt: new Date('2026-07-19T12:15:00.000Z'),
            },
        ],
    });

    for (const fixture of STANDARD_TRAINING_MOMENTS) {
        await seedTrainingMoment(prisma, fixture);
    }
    await seedTrainingMoment(prisma, {
        id: E2E_TRAINING_MOMENTS.promotion,
        revisionId: E2E_SOLUTION_REVISIONS.promotion,
        userId: E2E_USER.id,
        gameId: E2E_GAMES.promotion,
        analysisRunId: E2E_ANALYSIS_RUNS.promotion,
        decisionPly: 0,
        fen: PROMOTION_FEN,
        sideToMove: 'w',
        originalMoveUci: 'a7a8q',
        phase: 'ENDGAME',
        bestMoveUci: 'a7a8n',
        acceptedMovesUci: ['a7a8n'],
        bestLineUci: ['a7a8n'],
        sourceKinds: ['MISSED_OPPORTUNITY'],
        lessonKinds: ['CONVERT_ADVANTAGE'],
        themes: ['promotion', 'underpromotion'],
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
        await deleteE2eUserGraph(prisma);
        await fs.rm(E2E_AUTH_STATE_PATH, { force: true });
        throw error;
    } finally {
        await prisma.$disconnect();
    }

    return async () => {
        assertSafeE2eDatabase();
        const cleanupPrisma = new PrismaClient();
        try {
            await deleteE2eUserGraph(cleanupPrisma);
        } finally {
            await cleanupPrisma.$disconnect();
            await fs.rm(E2E_AUTH_STATE_PATH, { force: true });
        }
    };
}
