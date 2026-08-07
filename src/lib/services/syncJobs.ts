import { Prisma, type SyncProvider } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { publishBackranqQueueMessage } from '@/lib/queues/backranq';
import { prisma } from '@/lib/prisma';
import {
    canonicalPreferences,
    providerImportTimeControls,
    type PreferencesSchema,
} from '@/lib/preferences';
import {
    recordSyncCompleted,
    recordSyncFailed,
} from '@/lib/notifications/service';
import {
    StaleSyncJobLeaseError,
    syncUserProvider,
    type SyncProviderResult,
} from '@/lib/services/autoSync';
import {
    chessAccountConnectionSelect,
    usernameForProvider,
    type ChessAccountConnectionSnapshot,
} from '@/lib/accounts/chessAccountConnections';

const SYNC_JOB_LEASE_MS = 10 * 60 * 1_000;
const SYNC_JOB_HEARTBEAT_MS = 60 * 1_000;
const SYNC_JOB_MAX_ATTEMPTS = 5;
const SYNC_RETRY_BACKOFF_BASE_MS = 60_000;
const SYNC_RETRY_BACKOFF_MAX_MS = 30 * 60_000;
const DEFAULT_SYNC_JOB_LIMIT = 50;

type SyncJobUser = {
    id: string;
    preferences: unknown;
    chessAccountConnections: ChessAccountConnectionSnapshot[];
    providerSyncStates?: Array<{
        provider: SyncProvider;
        lastSuccessAt?: Date | null;
        lastAttemptAt?: Date | null;
        cursorUntilPlayedAt?: Date | null;
    }>;
    accounts?: Array<{ access_token: string | null }>;
};

export type PlannedSyncJob = {
    userId: string;
    provider: SyncProvider;
    queued: boolean;
    jobId: string | null;
    skippedReason: string | null;
};

export type UserSyncProviderActivity = {
    provider: SyncProvider;
    linked: boolean;
    username: string | null;
    state: {
        providerUsernameNormalized: string | null;
        lastSyncedPlayedAt: Date | null;
        lastAttemptAt: Date | null;
        lastSuccessAt: Date | null;
        lastError: string | null;
        hasPendingCursor: boolean;
    } | null;
    activeJob: SyncJobSummary | null;
    latestJob: SyncJobSummary | null;
};

export type SyncJobSummary = {
    id: string;
    status: string;
    scheduledFor: Date;
    startedAt: Date | null;
    completedAt: Date | null;
    fetchedCount: number;
    savedCount: number;
    createdCount: number;
    updatedCount: number;
    queuedAnalysisCount: number;
    lastError: string | null;
};

export type UserSyncActivity = {
    providers: UserSyncProviderActivity[];
    requestedJobs?: SyncJobSummary[];
};

export type PlanSyncJobsResult = {
    usersScanned: number;
    jobsCreated: number;
    jobsExisting: number;
    providers: PlannedSyncJob[];
};

export type ProcessSyncJobResult = {
    jobId: string;
    provider: SyncProvider;
    result: SyncProviderResult;
};

export type DispatchSyncJobsResult = PlanSyncJobsResult & {
    published: Array<{
        jobId: string;
        queued: boolean;
        messageId: string | null;
        jobStatus: string | null;
    }>;
};

export type ProcessDueSyncJobsResult = {
    processed: ProcessSyncJobResult[];
};

const SYNC_JOB_SUMMARY_SELECT = {
    id: true,
    provider: true,
    status: true,
    scheduledFor: true,
    startedAt: true,
    completedAt: true,
    fetchedCount: true,
    savedCount: true,
    createdCount: true,
    updatedCount: true,
    queuedAnalysisCount: true,
    lastError: true,
} as const;

export async function planSyncJobs(args: { scheduledFor?: Date; now?: Date } = {}) {
    const scheduledFor = args.scheduledFor ?? new Date();
    const now = args.now ?? new Date();
    const users = await prisma.user.findMany({
        where: {
            chessAccountConnections: { some: {} },
        },
        select: {
            id: true,
            preferences: true,
            chessAccountConnections: {
                select: chessAccountConnectionSelect,
            },
            providerSyncStates: {
                select: {
                    provider: true,
                    lastSuccessAt: true,
                    lastAttemptAt: true,
                    cursorUntilPlayedAt: true,
                },
            },
        },
    });

    const providers: PlannedSyncJob[] = [];
    for (const user of users) {
        for (const provider of ['LICHESS', 'CHESSCOM'] as const) {
            providers.push(
                await planUserProviderSyncJob({
                    user,
                    provider,
                    scheduledFor,
                    now,
                    respectAutoSyncPreferences: true,
                })
            );
        }
    }

    return {
        usersScanned: users.length,
        jobsCreated: providers.filter((provider) => provider.queued).length,
        jobsExisting: providers.filter(
            (provider) => provider.skippedReason === 'already-queued'
        ).length,
        providers,
    } satisfies PlanSyncJobsResult;
}

export async function planUserSyncJobs(args: {
    userId: string;
    providers?: SyncProvider[];
    onlyIfStaleMinutes?: number;
    scheduledFor?: Date;
    now?: Date;
}): Promise<PlannedSyncJob[]> {
    const now = args.now ?? new Date();
    const user = await prisma.user.findUnique({
        where: { id: args.userId },
        select: {
            id: true,
            preferences: true,
            chessAccountConnections: {
                select: chessAccountConnectionSelect,
            },
            providerSyncStates: {
                select: {
                    provider: true,
                    lastSuccessAt: true,
                    lastAttemptAt: true,
                    cursorUntilPlayedAt: true,
                },
            },
        },
    });
    if (!user) throw new Error('User not found');

    const providers = args.providers?.length
        ? Array.from(new Set(args.providers))
        : (['LICHESS', 'CHESSCOM'] as SyncProvider[]);
    const planned: PlannedSyncJob[] = [];
    for (const provider of providers) {
        planned.push(
            await planUserProviderSyncJob({
                user,
                provider,
                scheduledFor: args.scheduledFor ?? now,
                now,
                // A stale-threshold request is the non-interactive app-open
                // trigger and must honor automation preferences. Omitting the
                // threshold is an explicit user action and may sync any linked
                // provider the user selected.
                respectAutoSyncPreferences:
                    args.onlyIfStaleMinutes != null,
                onlyIfStaleMinutes: args.onlyIfStaleMinutes,
            })
        );
    }
    return planned;
}

export async function dispatchUserSyncJobs(args: {
    userId: string;
    providers?: SyncProvider[];
    onlyIfStaleMinutes?: number;
    scheduledFor?: Date;
    now?: Date;
}) {
    const providers = await planUserSyncJobs(args);
    const published: DispatchSyncJobsResult['published'] = [];
    for (const job of providers) {
        if (!job.jobId) continue;
        published.push(
            await publishSyncJobWakeup(job.jobId, args.now ?? new Date())
        );
    }
    return { providers, published };
}

export async function getUserSyncActivity(
    userId: string,
    options: { requestedJobIds?: string[] } = {}
): Promise<UserSyncActivity> {
    const requestedJobIds = Array.from(
        new Set((options.requestedJobIds ?? []).filter(Boolean))
    ).slice(0, 4);
    const [
        user,
        states,
        lichessActive,
        chesscomActive,
        lichessLatest,
        chesscomLatest,
        requestedJobs,
    ] = await Promise.all([
        prisma.chessAccountConnection.findMany({
            where: { userId },
            select: chessAccountConnectionSelect,
        }),
        prisma.providerSyncState.findMany({
            where: { userId },
            select: {
                provider: true,
                providerUsernameNormalized: true,
                lastSyncedPlayedAt: true,
                cursorSincePlayedAt: true,
                cursorUntilPlayedAt: true,
                cursorWindowEnd: true,
                lastAttemptAt: true,
                lastSuccessAt: true,
                lastError: true,
            },
        }),
        prisma.syncJob.findFirst({
            where: {
                userId,
                provider: 'LICHESS',
                status: { in: ['QUEUED', 'RUNNING'] },
            },
            orderBy: { createdAt: 'desc' },
            select: SYNC_JOB_SUMMARY_SELECT,
        }),
        prisma.syncJob.findFirst({
            where: {
                userId,
                provider: 'CHESSCOM',
                status: { in: ['QUEUED', 'RUNNING'] },
            },
            orderBy: { createdAt: 'desc' },
            select: SYNC_JOB_SUMMARY_SELECT,
        }),
        prisma.syncJob.findFirst({
            where: { userId, provider: 'LICHESS' },
            orderBy: { createdAt: 'desc' },
            select: SYNC_JOB_SUMMARY_SELECT,
        }),
        prisma.syncJob.findFirst({
            where: { userId, provider: 'CHESSCOM' },
            orderBy: { createdAt: 'desc' },
            select: SYNC_JOB_SUMMARY_SELECT,
        }),
        requestedJobIds.length > 0
            ? prisma.syncJob.findMany({
                  where: {
                      userId,
                      id: { in: requestedJobIds },
                  },
                  take: 4,
                  select: SYNC_JOB_SUMMARY_SELECT,
              })
            : Promise.resolve([]),
    ]);
    const activeByProvider = {
        LICHESS: lichessActive,
        CHESSCOM: chesscomActive,
    } as const;
    const latestByProvider = {
        LICHESS: lichessLatest,
        CHESSCOM: chesscomLatest,
    } as const;

    const activity: UserSyncActivity = {
        providers: (['LICHESS', 'CHESSCOM'] as const).map((provider) => {
            const state = states.find((item) => item.provider === provider);
            const active = activeByProvider[provider];
            const latest = latestByProvider[provider];
            return {
                provider,
                linked: !!usernameForProvider(user, provider),
                username: usernameForProvider(user, provider),
                state: state
                    ? {
                          providerUsernameNormalized:
                              state.providerUsernameNormalized,
                          lastSyncedPlayedAt: state.lastSyncedPlayedAt,
                          lastAttemptAt: state.lastAttemptAt,
                          lastSuccessAt: state.lastSuccessAt,
                          lastError: state.lastError,
                          hasPendingCursor: !!(
                              state.cursorSincePlayedAt &&
                              state.cursorUntilPlayedAt &&
                              state.cursorWindowEnd
                          ),
                      }
                    : null,
                activeJob: active ? syncJobSummary(active) : null,
                latestJob: latest ? syncJobSummary(latest) : null,
            };
        }),
    };
    if (requestedJobIds.length > 0) {
        const byId = new Map(
            requestedJobs.map((job) => [job.id, syncJobSummary(job)])
        );
        activity.requestedJobs = requestedJobIds.flatMap((id) => {
            const job = byId.get(id);
            return job ? [job] : [];
        });
    }
    return activity;
}

export async function dispatchPlannedSyncJobs(
    args: { scheduledFor?: Date; now?: Date } = {}
): Promise<DispatchSyncJobsResult> {
    const plan = await planSyncJobs(args);
    const published: DispatchSyncJobsResult['published'] = [];
    for (const job of plan.providers) {
        if (!job.jobId) continue;
        published.push(
            await publishSyncJobWakeup(job.jobId, args.now ?? new Date())
        );
    }
    return { ...plan, published };
}

export async function planAndProcessDueSyncJobsInline(args: {
    scheduledFor?: Date;
    now?: Date;
    limit?: number;
} = {}) {
    const plan = await planSyncJobs({
        scheduledFor: args.scheduledFor,
        now: args.now,
    });
    const processed = await processDueSyncJobs({
        now: args.now,
        limit: args.limit,
    });
    return { plan, processed };
}

export async function processDueSyncJobs(args: {
    now?: Date;
    limit?: number;
} = {}): Promise<ProcessDueSyncJobsResult> {
    const now = args.now ?? new Date();
    const jobs = await prisma.syncJob.findMany({
        where: {
            OR: [
                {
                    status: 'QUEUED',
                    scheduledFor: { lte: now },
                    OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }],
                },
                {
                    status: 'RUNNING',
                    OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }],
                },
            ],
        },
        orderBy: [{ scheduledFor: 'asc' }, { createdAt: 'asc' }],
        take: args.limit ?? DEFAULT_SYNC_JOB_LIMIT,
    });

    const processed: ProcessSyncJobResult[] = [];
    for (const job of jobs) {
        processed.push(await processSyncJob(job.id, { now }));
    }
    return { processed };
}

export async function processSyncJob(
    jobId: string,
    args: { now?: Date } = {}
): Promise<ProcessSyncJobResult> {
    const now = args.now ?? new Date();
    const lockedUntil = new Date(now.getTime() + SYNC_JOB_LEASE_MS);
    const leaseToken = randomUUID();
    const claim = await prisma.syncJob.updateMany({
        where: {
            id: jobId,
            OR: [
                {
                    status: 'QUEUED',
                    scheduledFor: { lte: now },
                    OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }],
                },
                {
                    status: 'RUNNING',
                    OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }],
                },
            ],
        },
        data: {
            status: 'RUNNING',
            attempts: { increment: 1 },
            startedAt: now,
            completedAt: null,
            lockedUntil,
            leaseToken,
            lastError: null,
        },
    });
    if (claim.count !== 1) {
        throw new Error('Sync job is not available to process');
    }

    const job = await prisma.syncJob.findUnique({
        where: { id: jobId },
        include: {
            user: {
                select: {
                    id: true,
                    preferences: true,
                    chessAccountConnections: {
                        select: chessAccountConnectionSelect,
                    },
                    accounts: {
                        where: { provider: 'lichess' },
                        select: { access_token: true },
                        take: 1,
                    },
                },
            },
        },
    });
    if (!job) throw new Error('Sync job not found');

    const heartbeat = startSyncJobHeartbeat(job.id, leaseToken);
    try {
        const prefs = canonicalPreferences(job.user.preferences ?? {});
        const result = await syncUserProvider({
            user: job.user,
            provider: job.provider,
            prefs,
            lichessAccessToken: job.user.accounts[0]?.access_token ?? null,
            force: true,
            jobLease: {
                jobId: job.id,
                leaseToken,
            },
        });
        if (result.error) {
            const retried = await retryOrFailSyncJob({
                job,
                leaseToken,
                error: result.error,
                now,
                result,
                immediate:
                    result.identityChanged === true ||
                    result.policyChanged === true,
            });
            if (retried.stale) return staleProcessResult(job);
            if (retried.status === 'QUEUED') {
                await publishSyncJobWakeup(job.id, now);
            } else {
                await recordSyncFailed({
                    userId: job.userId,
                    jobId: job.id,
                    provider: job.provider,
                    error: result.error,
                }).catch((notificationError) => {
                    console.error('[notifications] sync failure event was not recorded', notificationError);
                });
            }
            return { jobId: job.id, provider: job.provider, result };
        }
        if (!result.complete) {
            const continued = await prisma.syncJob.updateMany({
                where: {
                    id: job.id,
                    status: 'RUNNING',
                    leaseToken,
                },
                data: {
                    status: 'QUEUED',
                    scheduledFor: now,
                    attempts: 0,
                    startedAt: null,
                    completedAt: null,
                    lockedUntil: null,
                    leaseToken: null,
                    lastError: null,
                    fetchedCount: { increment: result.fetched },
                    savedCount: { increment: result.saved },
                    createdCount: { increment: result.created },
                    updatedCount: { increment: result.updated },
                    queuedAnalysisCount: {
                        increment: result.queuedAnalysis,
                    },
                },
            });
            if (continued.count !== 1) return staleProcessResult(job);
            await publishSyncJobWakeup(job.id, now);
            return { jobId: job.id, provider: job.provider, result };
        }
        const completed = await prisma.$transaction(async (tx) => {
            const updated = await tx.syncJob.updateMany({
                where: {
                    id: job.id,
                    status: 'RUNNING',
                    leaseToken,
                },
                data: {
                    status: 'SUCCEEDED',
                    completedAt: now,
                    lockedUntil: null,
                    leaseToken: null,
                    lastError: null,
                    fetchedCount: { increment: result.fetched },
                    savedCount: { increment: result.saved },
                    createdCount: { increment: result.created },
                    updatedCount: { increment: result.updated },
                    queuedAnalysisCount: {
                        increment: result.queuedAnalysis,
                    },
                },
            });
            if (updated.count === 1) {
                await recordSyncCompleted(
                    {
                        userId: job.userId,
                        jobId: job.id,
                        provider: job.provider,
                        newGames: job.createdCount + result.created,
                    },
                    tx
                );
            }
            return updated;
        });
        if (completed.count !== 1) return staleProcessResult(job);
        return { jobId: job.id, provider: job.provider, result };
    } catch (error) {
        if (error instanceof StaleSyncJobLeaseError) {
            return staleProcessResult(job);
        }
        const retried = await retryOrFailSyncJob({
            job,
            leaseToken,
            error,
            now,
        });
        if (retried.stale) return staleProcessResult(job);
        if (retried.status === 'QUEUED') {
            await publishSyncJobWakeup(job.id, now);
        } else {
            await recordSyncFailed({
                userId: job.userId,
                jobId: job.id,
                provider: job.provider,
                error: errorMessage(error),
            }).catch((notificationError) => {
                console.error('[notifications] sync failure event was not recorded', notificationError);
            });
        }
        return {
            jobId: job.id,
            provider: job.provider,
            result: {
                provider: job.provider,
                username: providerUsername(job.provider, job.user) ?? '',
                fetched: 0,
                saved: 0,
                created: 0,
                updated: 0,
                importedGameIds: [],
                queuedAnalysis: 0,
                analysisErrors: 0,
                complete: false,
                skipped: false,
                error: errorMessage(error),
            },
        };
    } finally {
        await heartbeat.stop();
    }
}

function startSyncJobHeartbeat(jobId: string, leaseToken: string) {
    let stopped = false;
    let inFlight: Promise<unknown> = Promise.resolve();
    const timer = setInterval(() => {
        if (stopped) return;
        inFlight = prisma.syncJob
            .updateMany({
                where: {
                    id: jobId,
                    status: 'RUNNING',
                    leaseToken,
                },
                data: {
                    lockedUntil: new Date(Date.now() + SYNC_JOB_LEASE_MS),
                },
            })
            .catch(() => {
                // The transaction-level lease fence remains authoritative. A
                // transient heartbeat failure must not grant this worker
                // ownership or mutate the job through an unfenced fallback.
            });
    }, SYNC_JOB_HEARTBEAT_MS);
    timer.unref?.();

    return {
        async stop() {
            stopped = true;
            clearInterval(timer);
            await inFlight;
        },
    };
}

function staleProcessResult(job: {
    id: string;
    provider: SyncProvider;
    user: { chessAccountConnections: ChessAccountConnectionSnapshot[] };
}): ProcessSyncJobResult {
    return {
        jobId: job.id,
        provider: job.provider,
        result: {
            provider: job.provider,
            username: providerUsername(job.provider, job.user) ?? '',
            fetched: 0,
            saved: 0,
            created: 0,
            updated: 0,
            importedGameIds: [],
            queuedAnalysis: 0,
            analysisErrors: 0,
            complete: false,
            skipped: true,
            error: 'Sync delivery was superseded by a newer worker lease',
        },
    };
}

async function planUserProviderSyncJob(args: {
    user: SyncJobUser;
    provider: SyncProvider;
    scheduledFor: Date;
    now: Date;
    respectAutoSyncPreferences: boolean;
    onlyIfStaleMinutes?: number;
}): Promise<PlannedSyncJob> {
    const username = providerUsername(args.provider, args.user);
    if (!username) return skipped(args.user.id, args.provider, 'unlinked');

    const state = args.user.providerSyncStates?.find(
        (item) => item.provider === args.provider
    );
    if (args.respectAutoSyncPreferences) {
        const prefs = canonicalPreferences(args.user.preferences ?? {});
        if (
            !automationImportsProvider(
                prefs,
                args.provider
            )
        ) {
            return skipped(args.user.id, args.provider, 'disabled');
        }
    }

    const recovered = await recoverExpiredSyncJobForProvider({
        userId: args.user.id,
        provider: args.provider,
        now: args.now,
    });
    if (recovered) {
        return {
            userId: args.user.id,
            provider: args.provider,
            queued: true,
            jobId: recovered.id,
            skippedReason: null,
        };
    }

    const existing = await prisma.syncJob.findFirst({
        where: {
            userId: args.user.id,
            provider: args.provider,
            OR: [
                { status: 'QUEUED' },
                { status: 'RUNNING', lockedUntil: { gt: args.now } },
            ],
        },
        orderBy: { createdAt: 'asc' },
    });
    if (existing) {
        return {
            userId: args.user.id,
            provider: args.provider,
            queued: false,
            jobId: existing.id,
            skippedReason: 'already-queued',
        };
    }

    const latestProviderActivityMs = Math.max(
        state?.lastSuccessAt?.getTime() ?? Number.NEGATIVE_INFINITY,
        state?.lastAttemptAt?.getTime() ?? Number.NEGATIVE_INFINITY
    );
    if (
        args.onlyIfStaleMinutes != null &&
        !state?.cursorUntilPlayedAt &&
        latestProviderActivityMs >
            args.now.getTime() - args.onlyIfStaleMinutes * 60_000
    ) {
        return skipped(args.user.id, args.provider, 'fresh');
    }

    const planned = await prisma.syncJob
        .create({
            data: {
                userId: args.user.id,
                provider: args.provider,
                scheduledFor: args.scheduledFor,
            },
        })
        .then((job) => ({ job, created: true }))
        .catch(async (error: unknown) => {
            if (!isUniqueConstraintError(error)) throw error;
            const job = await prisma.syncJob.findFirst({
                where: {
                    userId: args.user.id,
                    provider: args.provider,
                    OR: [
                        { status: 'QUEUED' },
                        { status: 'RUNNING', lockedUntil: { gt: args.now } },
                    ],
                },
                orderBy: { createdAt: 'asc' },
            });
            return { job, created: false };
        });
    if (!planned.job) {
        throw new Error('Sync job unique conflict without an active job');
    }
    if (!planned.created) {
        return {
            userId: args.user.id,
            provider: args.provider,
            queued: false,
            jobId: planned.job.id,
            skippedReason: 'already-queued',
        };
    }
    return {
        userId: args.user.id,
        provider: args.provider,
        queued: true,
        jobId: planned.job.id,
        skippedReason: null,
    };
}

function syncJobSummary(job: {
    id: string;
    status: string;
    scheduledFor: Date;
    startedAt: Date | null;
    completedAt: Date | null;
    fetchedCount: number;
    savedCount: number;
    createdCount: number;
    updatedCount: number;
    queuedAnalysisCount: number;
    lastError: string | null;
}): SyncJobSummary {
    return {
        id: job.id,
        status: job.status,
        scheduledFor: job.scheduledFor,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
        fetchedCount: job.fetchedCount,
        savedCount: job.savedCount,
        createdCount: job.createdCount,
        updatedCount: job.updatedCount,
        queuedAnalysisCount: job.queuedAnalysisCount,
        lastError: job.lastError,
    };
}

function skipped(
    userId: string,
    provider: SyncProvider,
    skippedReason: string
): PlannedSyncJob {
    return { userId, provider, queued: false, jobId: null, skippedReason };
}

function providerUsername(
    provider: SyncProvider,
    user: { chessAccountConnections: ChessAccountConnectionSnapshot[] }
) {
    return usernameForProvider(user.chessAccountConnections, provider);
}

function automationImportsProvider(
    prefs: PreferencesSchema,
    provider: SyncProvider
) {
    return (
        providerImportTimeControls(
            prefs.gameAutomation,
            provider === 'LICHESS' ? 'lichess' : 'chesscom'
        ).length > 0
    );
}

async function recoverExpiredSyncJobForProvider(args: {
    userId: string;
    provider: SyncProvider;
    now: Date;
}) {
    const job = await prisma.syncJob.findFirst({
        where: {
            userId: args.userId,
            provider: args.provider,
            status: 'RUNNING',
            OR: [{ lockedUntil: null }, { lockedUntil: { lte: args.now } }],
        },
        orderBy: [{ lockedUntil: 'asc' }, { createdAt: 'asc' }],
    });
    if (!job) return null;

    if (job.attempts >= SYNC_JOB_MAX_ATTEMPTS) {
        await prisma.syncJob.updateMany({
            where: {
                id: job.id,
                status: 'RUNNING',
                leaseToken: job.leaseToken,
                OR: [
                    { lockedUntil: null },
                    { lockedUntil: { lte: args.now } },
                ],
            },
            data: {
                status: 'FAILED',
                lockedUntil: null,
                leaseToken: null,
                completedAt: args.now,
                lastError: 'Sync job lease expired after maximum attempts',
            },
        });
        return null;
    }

    const recovered = await prisma.syncJob.updateMany({
        where: {
            id: job.id,
            status: 'RUNNING',
            leaseToken: job.leaseToken,
            OR: [
                { lockedUntil: null },
                { lockedUntil: { lte: args.now } },
            ],
        },
        data: {
            status: 'QUEUED',
            scheduledFor: syncRetryScheduledFor({
                attempts: Math.max(1, job.attempts),
                now: args.now,
            }),
            startedAt: null,
            completedAt: null,
            lockedUntil: null,
            leaseToken: null,
            lastError: 'Sync job lease expired and was requeued',
        },
    });
    return recovered.count === 1 ? { id: job.id } : null;
}

async function retryOrFailSyncJob(args: {
    job: {
        id: string;
        attempts: number;
    };
    leaseToken: string;
    error: unknown;
    now: Date;
    result?: SyncProviderResult;
    immediate?: boolean;
}) {
    const lastError = errorMessage(args.error).slice(0, 2_000);
    const countUpdates = args.result
        ? {
              fetchedCount: { increment: args.result.fetched },
              savedCount: { increment: args.result.saved },
              createdCount: { increment: args.result.created },
              updatedCount: { increment: args.result.updated },
              queuedAnalysisCount: {
                  increment: args.result.queuedAnalysis,
              },
          }
        : {};
    if (args.job.attempts < SYNC_JOB_MAX_ATTEMPTS) {
        const update = await prisma.syncJob.updateMany({
            where: {
                id: args.job.id,
                status: 'RUNNING',
                leaseToken: args.leaseToken,
            },
            data: {
                status: 'QUEUED',
                scheduledFor: args.immediate
                    ? args.now
                    : syncRetryScheduledFor({
                          attempts: Math.max(1, args.job.attempts),
                          now: args.now,
                      }),
                startedAt: null,
                completedAt: null,
                lockedUntil: null,
                leaseToken: null,
                lastError,
                ...countUpdates,
            },
        });
        return {
            status: 'QUEUED' as const,
            stale: update.count !== 1,
        };
    }

    const update = await prisma.syncJob.updateMany({
        where: {
            id: args.job.id,
            status: 'RUNNING',
            leaseToken: args.leaseToken,
        },
        data: {
            status: 'FAILED',
            completedAt: args.now,
            lockedUntil: null,
            leaseToken: null,
            lastError,
            ...countUpdates,
        },
    });
    return {
        status: 'FAILED' as const,
        stale: update.count !== 1,
    };
}

async function publishSyncJobWakeup(
    jobId: string,
    now: Date
): Promise<DispatchSyncJobsResult['published'][number]> {
    const job = await prisma.syncJob.findUnique({
        where: { id: jobId },
        select: {
            id: true,
            status: true,
            attempts: true,
            scheduledFor: true,
            updatedAt: true,
        },
    });
    if (!job || job.status !== 'QUEUED') {
        return {
            jobId,
            queued: false,
            messageId: null,
            jobStatus: job?.status ?? null,
        };
    }

    const delaySeconds = Math.max(
        0,
        Math.ceil((job.scheduledFor.getTime() - now.getTime()) / 1_000)
    );
    try {
        const result = await publishBackranqQueueMessage(
            { type: 'sync-job', jobId },
            {
                idempotencyKey: `sync-job:${jobId}:state:${job.updatedAt.toISOString()}:attempt:${job.attempts + 1}`,
                delaySeconds,
            }
        );
        return {
            jobId,
            queued: result.queued,
            messageId: result.messageId,
            jobStatus: job.status,
        };
    } catch {
        // The database job remains the durable source of truth. A later manual,
        // app-open, or cron planning pass republishes every queued job.
        return {
            jobId,
            queued: false,
            messageId: null,
            jobStatus: job.status,
        };
    }
}

function syncRetryScheduledFor(args: { attempts: number; now: Date }) {
    const backoffMs = Math.min(
        SYNC_RETRY_BACKOFF_MAX_MS,
        SYNC_RETRY_BACKOFF_BASE_MS * 2 ** Math.max(0, args.attempts - 1)
    );
    return new Date(args.now.getTime() + backoffMs);
}

function errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
}

function isUniqueConstraintError(error: unknown) {
    return (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
    );
}
