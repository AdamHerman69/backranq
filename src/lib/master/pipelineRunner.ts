import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import {
    WEEKLY_MASTER_LEASE_MS,
    WEEKLY_MASTER_MAX_ATTEMPTS,
    weeklyMasterConfig,
} from '@/lib/master/config';
import {
    ensureDefaultMasterRoster,
    orderMasterAccountsForAnalysis,
} from '@/lib/master/roster';
import { fetchAndPersistMasterAccount } from '@/lib/master/source';
import { analyzeMasterSnapshot } from '@/lib/master/analysis';
import {
    markStaleMasterPublications,
    publishBestMasterCandidate,
} from '@/lib/master/publication';
import { masterContentHash } from '@/lib/master/ranking';
import {
    masterSnapshotFailureKind,
    type MasterSnapshotFailureKind,
} from '@/lib/master/analysisErrors';
import { WeeklyMasterTerminalError } from '@/lib/master/pipelineErrors';
import { MasterSourceProviderError } from '@/lib/master/sourceErrors';

type PipelineScope = 'FULL' | 'INGEST' | 'ANALYSIS';

export async function processWeeklyMasterRun(runId: string, now = new Date()) {
    const leaseToken = randomUUID();
    let claimed = await prisma.masterPipelineRun.updateMany({
        where: {
            id: runId,
            scheduledFor: { lte: now },
            OR: [
                { status: 'QUEUED' },
                {
                    status: 'FAILED',
                    attempts: { lt: WEEKLY_MASTER_MAX_ATTEMPTS },
                },
            ],
        },
        data: {
            status: 'RUNNING',
            leaseToken,
            lockedUntil: new Date(now.getTime() + WEEKLY_MASTER_LEASE_MS),
            startedAt: now,
            completedAt: null,
            lastError: null,
        },
    });
    if (claimed.count === 0) {
        // A hard crash cannot classify or persist the failed attempt. Reclaim
        // its expired lease without consuming another bounded-attempt slot.
        claimed = await prisma.masterPipelineRun.updateMany({
            where: {
                id: runId,
                scheduledFor: { lte: now },
                status: 'RUNNING',
                OR: [
                    { lockedUntil: null },
                    { lockedUntil: { lte: now } },
                ],
            },
            data: {
                leaseToken,
                lockedUntil: new Date(
                    now.getTime() + WEEKLY_MASTER_LEASE_MS
                ),
                startedAt: now,
                completedAt: null,
                lastError: null,
            },
        });
    }
    if (claimed.count !== 1) {
        const current = await prisma.masterPipelineRun.findUnique({
            where: { id: runId },
        });
        if (current?.status === 'SUCCEEDED') return current;
        if (!current) {
            throw new WeeklyMasterTerminalError(
                'Weekly Master run no longer exists'
            );
        }
        if (current.status === 'CANCELLED') {
            throw new WeeklyMasterTerminalError(
                'Weekly Master run was cancelled'
            );
        }
        if (
            current.status === 'FAILED' &&
            current.attempts >= WEEKLY_MASTER_MAX_ATTEMPTS
        ) {
            throw new WeeklyMasterTerminalError(
                'Weekly Master run exhausted its bounded attempts'
            );
        }
        throw new Error('Weekly Master run is not claimable');
    }
    const heartbeat = startHeartbeat(runId, leaseToken);
    let claimedRunAttempts = 0;
    try {
        const run = await prisma.masterPipelineRun.findUnique({
            where: { id: runId },
        });
        if (!run) throw new Error('Weekly Master run not found');
        claimedRunAttempts = run.attempts;
        const config = run.configSnapshot as unknown as ReturnType<
            typeof weeklyMasterConfig
        > & {
            scope?: PipelineScope;
            targetSourceGameId?: string | null;
        };
        if (
            config.version !== weeklyMasterConfig().version ||
            masterContentHash(config) !== run.configHash
        ) {
            throw new WeeklyMasterPermanentFailure(
                'Weekly Master run configuration is invalid'
            );
        }

        const accounts = (await ensureDefaultMasterRoster())
            .filter((account) => account.active && account.person.active)
            .sort(
                (left, right) =>
                    right.priority - left.priority ||
                    left.username.localeCompare(right.username)
            )
            .slice(0, config.source.maxAccountsPerRun);
        const analysisAccountOrder = new Map(
            orderMasterAccountsForAnalysis(accounts, now).map(
                (account, index) => [account.id, index]
            )
        );
        const since = new Date(
            now.getTime() - config.source.lookbackDays * 86_400_000
        );
        const analysisStagePending =
            run.stage === 'SOURCE' || run.stage === 'ANALYSIS';
        const shouldAnalyze =
            config.scope !== 'INGEST' && analysisStagePending;
        let fetchedGames = 0;
        let createdSnapshots = 0;
        const analysisInputs: Array<{
            snapshotId: string;
            accountId: string;
        }> = [];
        if (config.scope !== 'ANALYSIS' && run.stage === 'SOURCE') {
            for (const account of accounts) {
                try {
                    const fetched = await fetchAndPersistMasterAccount({
                        account,
                        pipelineRunId: run.id,
                        since,
                        maxGames: config.source.maxGamesPerAccount,
                        now,
                    });
                    fetchedGames += fetched.fetched;
                    createdSnapshots += fetched.snapshots.filter(
                        (item) => item.created
                    ).length;
                    for (const item of fetched.snapshots) {
                        analysisInputs.push({
                            snapshotId: item.snapshot.id,
                            accountId: account.id,
                        });
                    }
                } catch (error) {
                    if (!(error instanceof MasterSourceProviderError)) {
                        throw error;
                    }
                    // One unavailable creator must not prevent the other roster
                    // accounts from producing this week's fallback-safe slot.
                }
            }
            await fencedRunUpdate(run.id, leaseToken, {
                stage: 'ANALYSIS',
                fetchedGames,
                createdSnapshots,
            });
        } else if (shouldAnalyze) {
            const discoveries = await prisma.masterSourceGameDiscovery.findMany({
                where: {
                    ...(config.targetSourceGameId
                        ? { sourceGameId: config.targetSourceGameId }
                        : {}),
                    account: { active: true, person: { active: true } },
                    sourceGame: {
                        availability: 'AVAILABLE',
                        currentSnapshotId: { not: null },
                    },
                },
                include: { sourceGame: true },
                orderBy: { lastSeenAt: 'desc' },
                take: config.analysis.maxSnapshotsPerRun * 4,
            });
            for (const discovery of discoveries) {
                if (discovery.sourceGame.currentSnapshotId) {
                    analysisInputs.push({
                        snapshotId: discovery.sourceGame.currentSnapshotId,
                        accountId: discovery.accountId,
                    });
                }
            }
        }

        const completedRunReceipts = shouldAnalyze
            ? await prisma.masterAnalysisReceipt.findMany({
                  where: {
                      pipelineRunId: run.id,
                      configHash: config.analysis.configHash,
                      complete: true,
                  },
                  select: { snapshotId: true, accountId: true },
              })
            : [];
        let analyzedSnapshots = shouldAnalyze
            ? completedRunReceipts.length
            : run.analyzedSnapshots;
        let eligibleCandidates = shouldAnalyze
            ? 0
            : run.eligibleCandidates;
        for (const receipt of completedRunReceipts) {
            eligibleCandidates += await prisma.masterCandidate.count({
                where: {
                    pipelineRunId: run.id,
                    snapshotId: receipt.snapshotId,
                    accountId: receipt.accountId,
                    hardGatePassed: true,
                },
            });
        }
        let analysisAttempts = completedRunReceipts.length;
        const completedRunReceiptKeys = new Set(
            completedRunReceipts.map(
                (receipt) => `${receipt.snapshotId}:${receipt.accountId}`
            )
        );
        const analysisErrors: string[] = [];
        let lastAttemptedAnalysisInput: {
            snapshotId: string;
            accountId: string;
            configHash: string;
        } | null = null;
        let lastAnalysisFailureKind: MasterSnapshotFailureKind | null = null;
        const seen = new Set<string>();
        const orderedAnalysisInputs = analysisInputs.sort(
            (left, right) =>
                (analysisAccountOrder.get(left.accountId) ??
                    Number.MAX_SAFE_INTEGER) -
                (analysisAccountOrder.get(right.accountId) ??
                    Number.MAX_SAFE_INTEGER)
        );
        for (const input of shouldAnalyze ? orderedAnalysisInputs : []) {
            if (analysisAttempts >= config.analysis.maxSnapshotsPerRun) break;
            const key = `${input.snapshotId}:${input.accountId}`;
            if (seen.has(key)) continue;
            seen.add(key);
            if (completedRunReceiptKeys.has(key)) continue;
            const account = await prisma.masterAccount.findUnique({
                where: { id: input.accountId },
                select: { personId: true },
            });
            if (!account) continue;
            const existing = await prisma.masterAnalysisReceipt.findUnique({
                where: {
                    snapshotId_accountId_configHash: {
                        snapshotId: input.snapshotId,
                        accountId: input.accountId,
                        configHash: config.analysis.configHash,
                    },
                },
                select: { complete: true, pipelineRunId: true },
            });
            if (existing?.complete) {
                if (existing.pipelineRunId === run.id) {
                    analysisAttempts += 1;
                    analyzedSnapshots += 1;
                    eligibleCandidates += await prisma.masterCandidate.count({
                        where: {
                            pipelineRunId: run.id,
                            snapshotId: input.snapshotId,
                            accountId: input.accountId,
                            hardGatePassed: true,
                        },
                    });
                }
                continue;
            }
            if (existing?.pipelineRunId === run.id) {
                continue;
            }
            analysisAttempts += 1;
            lastAttemptedAnalysisInput = {
                ...input,
                configHash: config.analysis.configHash,
            };
            try {
                const result = await analyzeMasterSnapshot({
                    ...input,
                    pipelineRunId: run.id,
                    config,
                    now,
                });
                analyzedSnapshots += 1;
                eligibleCandidates += result.candidates.filter(
                    (candidate) => candidate.hardGatePassed
                ).length;
            } catch (error) {
                const failureKind = masterSnapshotFailureKind(error);
                if (!failureKind) throw error;
                // Snapshot-domain failures are bounded. The fenced failure
                // receipt makes a later delivery select the next fresh input.
                lastAnalysisFailureKind = failureKind;
                analysisErrors.push(errorMessage(error));
            }
            if (analysisAttempts >= config.analysis.maxSnapshotsPerRun) break;
        }
        if (analysisAttempts > 0 && analyzedSnapshots === 0) {
            if (!lastAttemptedAnalysisInput || !lastAnalysisFailureKind) {
                throw new Error(
                    'Weekly Master analysis failure lost its input provenance'
                );
            }
            throw new WeeklyMasterBoundedFailure(
                `All Weekly Master analyses failed: ${analysisErrors.join(' | ')}`,
                lastAttemptedAnalysisInput,
                lastAnalysisFailureKind
            );
        }
        if (analysisStagePending) {
            await fencedRunUpdate(run.id, leaseToken, {
                stage: 'RANKING',
                analyzedSnapshots,
                eligibleCandidates,
            });
        }

        let publishedCount = 0;
        if (config.scope !== 'INGEST') {
            const publication = await publishBestMasterCandidate({
                pipelineRunId: run.id,
                now,
            });
            publishedCount = publication ? 1 : 0;
        }
        await markStaleMasterPublications(now);
        const completed = await prisma.masterPipelineRun.updateMany({
            where: { id: run.id, status: 'RUNNING', leaseToken },
            data: {
                status: 'SUCCEEDED',
                stage: 'COMPLETE',
                publishedCount,
                completedAt: new Date(),
                lockedUntil: null,
                leaseToken: null,
                lastError: null,
            },
        });
        if (completed.count !== 1) {
            throw new Error('Weekly Master completion lost its lease');
        }
        return prisma.masterPipelineRun.findUniqueOrThrow({
            where: { id: run.id },
        });
    } catch (error) {
        const permanent = error instanceof WeeklyMasterPermanentFailure;
        const bounded = error instanceof WeeklyMasterBoundedFailure;
        const exhausted =
            bounded &&
            claimedRunAttempts + 1 >= WEEKLY_MASTER_MAX_ATTEMPTS;
        const failed = bounded
            ? await persistBoundedAnalysisFailure({
                  runId,
                  leaseToken,
                  failure: error,
                  exhausted,
              })
            : await prisma.masterPipelineRun.updateMany({
                  where: { id: runId, status: 'RUNNING', leaseToken },
                  data: permanent
                      ? {
                            status: 'FAILED',
                            attempts: {
                                set: WEEKLY_MASTER_MAX_ATTEMPTS,
                            },
                            completedAt: new Date(),
                            lockedUntil: null,
                            leaseToken: null,
                            lastError: errorMessage(error),
                        }
                      : {
                            status: 'QUEUED',
                            completedAt: null,
                            lockedUntil: null,
                            leaseToken: null,
                            lastError: errorMessage(error),
                        },
              });
        if (failed.count !== 1) {
            throw new Error('Weekly Master failure lost its lease', {
                cause: error,
            });
        }
        if (permanent || exhausted) {
            throw new WeeklyMasterTerminalError(errorMessage(error), {
                cause: error,
            });
        }
        throw error;
    } finally {
        await heartbeat.stop();
    }
}

class WeeklyMasterBoundedFailure extends Error {
    constructor(
        message: string,
        readonly input: {
            snapshotId: string;
            accountId: string;
            configHash: string;
        },
        readonly failureKind: MasterSnapshotFailureKind
    ) {
        super(message);
        this.name = 'WeeklyMasterBoundedFailure';
    }
}

class WeeklyMasterPermanentFailure extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'WeeklyMasterPermanentFailure';
    }
}

async function persistBoundedAnalysisFailure(args: {
    runId: string;
    leaseToken: string;
    failure: WeeklyMasterBoundedFailure;
    exhausted: boolean;
}) {
    return prisma.$transaction(async (tx) => {
        const failed = await tx.masterPipelineRun.updateMany({
            where: {
                id: args.runId,
                status: 'RUNNING',
                leaseToken: args.leaseToken,
            },
            data: {
                status: args.exhausted ? 'FAILED' : 'QUEUED',
                attempts: args.exhausted
                    ? { set: WEEKLY_MASTER_MAX_ATTEMPTS }
                    : { increment: 1 },
                completedAt: args.exhausted ? new Date() : null,
                lockedUntil: null,
                leaseToken: null,
                lastError: errorMessage(args.failure),
            },
        });
        if (failed.count !== 1) return failed;

        const manifest = {
            complete: false,
            failure: {
                kind: args.failure.failureKind,
                message: errorMessage(args.failure),
                recordedAt: new Date().toISOString(),
            },
        } satisfies Prisma.InputJsonObject;
        await tx.masterAnalysisReceipt.upsert({
            where: {
                snapshotId_accountId_configHash: {
                    snapshotId: args.failure.input.snapshotId,
                    accountId: args.failure.input.accountId,
                    configHash: args.failure.input.configHash,
                },
            },
            create: {
                snapshotId: args.failure.input.snapshotId,
                accountId: args.failure.input.accountId,
                pipelineRunId: args.runId,
                configHash: args.failure.input.configHash,
                complete: false,
                candidateCount: 0,
                manifest,
            },
            update: {
                pipelineRunId: args.runId,
                complete: false,
                candidateCount: 0,
                manifest,
            },
        });
        return failed;
    });
}

async function fencedRunUpdate(
    id: string,
    leaseToken: string,
    data: Prisma.MasterPipelineRunUpdateManyMutationInput
) {
    const updated = await prisma.masterPipelineRun.updateMany({
        where: { id, status: 'RUNNING', leaseToken },
        data,
    });
    if (updated.count !== 1) throw new Error('Weekly Master run lost its lease');
}

function startHeartbeat(runId: string, leaseToken: string) {
    let stopped = false;
    let inFlight: Promise<unknown> = Promise.resolve();
    const timer = setInterval(() => {
        if (stopped) return;
        inFlight = prisma.masterPipelineRun
            .updateMany({
                where: { id: runId, status: 'RUNNING', leaseToken },
                data: {
                    lockedUntil: new Date(
                        Date.now() + WEEKLY_MASTER_LEASE_MS
                    ),
                },
            })
            .catch(() => undefined);
    }, Math.floor(WEEKLY_MASTER_LEASE_MS / 3));
    timer.unref?.();
    return {
        async stop() {
            stopped = true;
            clearInterval(timer);
            await inFlight;
        },
    };
}

function errorMessage(error: unknown) {
    return (error instanceof Error ? error.message : String(error)).slice(
        0,
        2_000
    );
}
