import { Prisma } from '@prisma/client';
import { extractTrainingMomentsFromGames } from '@/lib/analysis/extractTrainingMoments';
import { ServerStockfishClient } from '@/lib/analysis/serverStockfishClient';
import { LichessTablebaseClient } from '@/lib/analysis/tablebase';
import { prisma } from '@/lib/prisma';
import type { NormalizedGame } from '@/lib/types/game';
import { timeClassToUi } from '@/lib/api/games';
import type { weeklyMasterConfig } from '@/lib/master/config';
import {
    masterCandidateKey,
    rankMasterCandidate,
} from '@/lib/master/ranking';

type WeeklyMasterConfig = ReturnType<typeof weeklyMasterConfig>;

function json(value: unknown): Prisma.InputJsonValue {
    return value as Prisma.InputJsonValue;
}

export async function analyzeMasterSnapshot(args: {
    snapshotId: string;
    accountId: string;
    pipelineRunId: string;
    config: WeeklyMasterConfig;
    now?: Date;
}) {
    const now = args.now ?? new Date();
    const snapshot = await prisma.masterSourceGameSnapshot.findUnique({
        where: { id: args.snapshotId },
        include: {
            sourceGame: {
                include: {
                    discoveries: {
                        where: { accountId: args.accountId },
                        include: { account: { include: { person: true } } },
                        take: 1,
                    },
                },
            },
        },
    });
    const discovery = snapshot?.sourceGame.discoveries[0];
    if (!snapshot || !discovery) {
        throw new Error('Master source snapshot is not attributed to this account');
    }
    const account = discovery.account;
    const normalized: NormalizedGame = {
        id: `master:${snapshot.id}`,
        provider: snapshot.sourceGame.provider === 'LICHESS' ? 'lichess' : 'chesscom',
        url: snapshot.sourceUrl ?? undefined,
        playedAt: snapshot.playedAt.toISOString(),
        timeClass: timeClassToUi(snapshot.timeClass),
        rated: snapshot.rated ?? undefined,
        white: {
            name: snapshot.whiteName,
            rating: snapshot.whiteRating ?? undefined,
        },
        black: {
            name: snapshot.blackName,
            rating: snapshot.blackRating ?? undefined,
        },
        result: snapshot.result ?? undefined,
        termination: snapshot.termination ?? undefined,
        pgn: snapshot.pgn,
        provenance: {
            username: account.username,
            userSide:
                discovery.featuredSide === 'WHITE'
                    ? 'white'
                    : discovery.featuredSide === 'BLACK'
                      ? 'black'
                      : 'unknown',
            timeControl: {
                raw: snapshot.timeControlRaw ?? undefined,
                initialSeconds:
                    snapshot.timeControlInitialSeconds ?? undefined,
                incrementSeconds:
                    snapshot.timeControlIncrementSeconds ?? undefined,
            },
        },
    };

    const engine = new ServerStockfishClient();
    try {
        const output = await extractTrainingMomentsFromGames({
            games: [normalized],
            selectedGameIds: new Set([normalized.id]),
            engine,
            tablebase: new LichessTablebaseClient(),
            canonicalSourceGameIdByGameId: {
                [normalized.id]: snapshot.id,
            },
            analysisConfigHash: args.config.analysis.configHash,
            usernameByProvider: {
                lichess:
                    normalized.provider === 'lichess'
                        ? account.username
                        : undefined,
                chesscom:
                    normalized.provider === 'chesscom'
                        ? account.username
                        : undefined,
            },
            options: args.config.analysis.options,
        });
        const manifest = output.manifests.find(
            (item) => item.sourceGameId === snapshot.id
        );
        if (!manifest?.complete || manifest.sourcePgnHash !== snapshot.pgnHash) {
            throw new Error('Master extraction did not produce a complete receipt');
        }

        const persisted = [];
        for (const moment of output.moments.filter(
            (item) => item.sourceGameId === snapshot.id
        )) {
            const ranking = rankMasterCandidate({
                moment,
                playedAt: snapshot.playedAt,
                personPriority: account.person.priority,
                now,
            });
            const solution = moment.solution;
            const candidateKey = masterCandidateKey({
                snapshotId: snapshot.id,
                personId: account.personId,
                decisionPly: moment.decisionPly,
                configHash: solution.configHash,
            });
            persisted.push(
                await prisma.masterCandidate.upsert({
                    where: { candidateKey },
                    create: {
                        snapshotId: snapshot.id,
                        personId: account.personId,
                        accountId: account.id,
                        pipelineRunId: args.pipelineRunId,
                        candidateKey,
                        decisionPly: moment.decisionPly,
                        fen: moment.fen,
                        positionHistory: moment.positionHistory,
                        sideToMove: moment.sideToMove,
                        originalMoveUci: moment.originalMoveUci,
                        scoreBefore: json(moment.originalDecision.scoreBefore),
                        scoreAfter: json(moment.originalDecision.scoreAfter),
                        cpLoss: moment.originalDecision.cpLoss ?? null,
                        winChanceLoss:
                            moment.originalDecision.winChanceLoss ?? null,
                        phase: moment.phase ?? null,
                        sourceKinds: moment.sourceKinds,
                        lessonKinds: moment.lessonKinds,
                        themes: moment.themes,
                        verificationStatus: solution.verificationStatus,
                        solutionShape: solution.solutionShape,
                        gradingStrategy: solution.gradingStrategy,
                        continuationShape: solution.continuationShape,
                        bestMoveUci: solution.bestMoveUci,
                        acceptedMovesUci: solution.acceptedMovesUci,
                        acceptanceFrontier: json(
                            solution.acceptanceFrontier
                        ),
                        bestLine: json(solution.bestLineUci),
                        solutionTree: json(solution.solutionTree),
                        moveAssessments: json(solution.moveAssessments),
                        scoreAtStart:
                            solution.scoreAtStart == null
                                ? Prisma.DbNull
                                : json(solution.scoreAtStart),
                        playedMoveScore:
                            solution.playedMoveScore == null
                                ? Prisma.DbNull
                                : json(solution.playedMoveScore),
                        targetOutcome: json(solution.targetOutcome),
                        gradingPolicy: json(solution.gradingPolicy),
                        evidence: json({
                            solution: solution.evidence,
                            extractionManifest: manifest,
                            analysisConfig:
                                args.config.analysis.snapshot,
                        }),
                        solutionHash: solution.solutionHash,
                        generatorVersion: solution.generatorVersion,
                        configHash: solution.configHash,
                        ...ranking,
                        status: ranking.hardGatePassed
                            ? 'ELIGIBLE'
                            : 'REJECTED',
                    },
                    update: {
                        pipelineRunId: args.pipelineRunId,
                        evidence: json({
                            solution: solution.evidence,
                            extractionManifest: manifest,
                            analysisConfig:
                                args.config.analysis.snapshot,
                        }),
                        ...ranking,
                        status: ranking.hardGatePassed
                            ? 'ELIGIBLE'
                            : 'REJECTED',
                    },
                })
            );
        }
        await prisma.masterAnalysisReceipt.upsert({
            where: {
                snapshotId_accountId_configHash: {
                    snapshotId: snapshot.id,
                    accountId: account.id,
                    configHash: args.config.analysis.configHash,
                },
            },
            create: {
                snapshotId: snapshot.id,
                accountId: account.id,
                pipelineRunId: args.pipelineRunId,
                configHash: args.config.analysis.configHash,
                complete: true,
                candidateCount: persisted.length,
                manifest: json(manifest),
            },
            update: {
                pipelineRunId: args.pipelineRunId,
                complete: true,
                candidateCount: persisted.length,
                manifest: json(manifest),
            },
        });
        return { manifest, candidates: persisted };
    } finally {
        engine.terminate();
    }
}
