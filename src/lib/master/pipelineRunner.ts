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

type PipelineScope = 'FULL' | 'INGEST' | 'ANALYSIS';

export async function processWeeklyMasterRun(runId: string, now = new Date()) {
    const leaseToken = randomUUID();
    const claimed = await prisma.masterPipelineRun.updateMany({
        where: {
            id: runId,
            scheduledFor: { lte: now },
            OR: [
                { status: 'QUEUED' },
                {
                    status: 'FAILED',
                    attempts: { lt: WEEKLY_MASTER_MAX_ATTEMPTS },
                },
                {
                    status: 'RUNNING',
                    OR: [
                        { lockedUntil: null },
                        { lockedUntil: { lte: now } },
                    ],
                },
            ],
        },
        data: {
            status: 'RUNNING',
            leaseToken,
            lockedUntil: new Date(now.getTime() + WEEKLY_MASTER_LEASE_MS),
            attempts: { increment: 1 },
            startedAt: now,
            completedAt: null,
            lastError: null,
        },
    });
    if (claimed.count !== 1) {
        const current = await prisma.masterPipelineRun.findUnique({
            where: { id: runId },
        });
        if (current?.status === 'SUCCEEDED') return current;
        throw new Error('Weekly Master run is not claimable');
    }
    const heartbeat = startHeartbeat(runId, leaseToken);
    try {
        const run = await prisma.masterPipelineRun.findUnique({
            where: { id: runId },
        });
        if (!run) throw new Error('Weekly Master run not found');
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
            throw new Error('Weekly Master run configuration is invalid');
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
        let fetchedGames = 0;
        let createdSnapshots = 0;
        const analysisInputs: Array<{
            snapshotId: string;
            accountId: string;
        }> = [];
        if (config.scope !== 'ANALYSIS') {
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
                } catch {
                    // One unavailable creator must not prevent the other roster
                    // accounts from producing this week's fallback-safe slot.
                }
            }
            await fencedRunUpdate(run.id, leaseToken, {
                stage: 'ANALYSIS',
                fetchedGames,
                createdSnapshots,
            });
        } else {
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

        let analyzedSnapshots = 0;
        let eligibleCandidates = 0;
        let analysisAttempts = 0;
        const analysisErrors: string[] = [];
        const seen = new Set<string>();
        const orderedAnalysisInputs = analysisInputs.sort(
            (left, right) =>
                (analysisAccountOrder.get(left.accountId) ?? Number.MAX_SAFE_INTEGER) -
                (analysisAccountOrder.get(right.accountId) ?? Number.MAX_SAFE_INTEGER)
        );
        for (const input of
            config.scope === 'INGEST' ? [] : orderedAnalysisInputs) {
            const key = `${input.snapshotId}:${input.accountId}`;
            if (seen.has(key)) continue;
            seen.add(key);
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
                select: { complete: true },
            });
            if (existing?.complete) continue;
            analysisAttempts += 1;
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
                // Candidate-level failures remain observable through zero output
                // and the source/run provenance; continue to the next fresh game.
                analysisErrors.push(errorMessage(error));
            }
            if (analysisAttempts >= config.analysis.maxSnapshotsPerRun) break;
        }
        if (analysisAttempts > 0 && analyzedSnapshots === 0) {
            throw new Error(
                `All Weekly Master analyses failed: ${analysisErrors.join(' | ')}`
            );
        }
        await fencedRunUpdate(run.id, leaseToken, {
            stage: 'RANKING',
            analyzedSnapshots,
            eligibleCandidates,
        });

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
        await prisma.masterPipelineRun.updateMany({
            where: { id: runId, status: 'RUNNING', leaseToken },
            data: {
                status: 'FAILED',
                completedAt: new Date(),
                lockedUntil: null,
                leaseToken: null,
                lastError: errorMessage(error),
            },
        });
        throw error;
    } finally {
        await heartbeat.stop();
    }
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
