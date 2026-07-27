import { Prisma, type Provider } from '@prisma/client';
import { publishBackranqQueueMessage } from '@/lib/queues/backranq';
import { prisma } from '@/lib/prisma';
import {
    defaultPreferences,
    mergePreferences,
    type PartialPreferences,
} from '@/lib/preferences';
import {
    syncUserProvider,
    type SyncProviderResult,
} from '@/lib/services/autoSync';

const SYNC_JOB_LEASE_MS = 10 * 60 * 1_000;
const SYNC_JOB_MAX_ATTEMPTS = 5;
const SYNC_RETRY_BACKOFF_BASE_MS = 60_000;
const SYNC_RETRY_BACKOFF_MAX_MS = 30 * 60_000;
const DEFAULT_SYNC_JOB_LIMIT = 50;

type SyncJobUser = {
    id: string;
    preferences: unknown;
    lichessUsername: string | null;
    chesscomUsername: string | null;
    providerSyncStates?: Array<{
        provider: Provider;
        enabled: boolean;
    }>;
    accounts?: Array<{ access_token: string | null }>;
};

export type PlannedSyncJob = {
    userId: string;
    provider: Provider;
    queued: boolean;
    jobId: string | null;
    skippedReason: string | null;
};

export type PlanSyncJobsResult = {
    usersScanned: number;
    jobsCreated: number;
    jobsExisting: number;
    providers: PlannedSyncJob[];
};

export type ProcessSyncJobResult = {
    jobId: string;
    provider: Provider;
    result: SyncProviderResult;
};

export type DispatchSyncJobsResult = PlanSyncJobsResult & {
    published: Array<{
        jobId: string;
        queued: boolean;
        messageId: string | null;
    }>;
};

export type ProcessDueSyncJobsResult = {
    processed: ProcessSyncJobResult[];
};

export async function planSyncJobs(args: { scheduledFor?: Date; now?: Date } = {}) {
    const scheduledFor = args.scheduledFor ?? new Date();
    const now = args.now ?? new Date();
    const users = await prisma.user.findMany({
        where: {
            OR: [
                { lichessUsername: { not: null } },
                { chesscomUsername: { not: null } },
            ],
        },
        select: {
            id: true,
            preferences: true,
            lichessUsername: true,
            chesscomUsername: true,
            providerSyncStates: {
                select: { provider: true, enabled: true },
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

export async function dispatchPlannedSyncJobs(
    args: { scheduledFor?: Date } = {}
): Promise<DispatchSyncJobsResult> {
    const plan = await planSyncJobs(args);
    const published: DispatchSyncJobsResult['published'] = [];
    for (const job of plan.providers) {
        if (!job.jobId || !job.queued) continue;
        const result = await publishBackranqQueueMessage(
            { type: 'sync-job', jobId: job.jobId },
            { idempotencyKey: `sync-job:${job.jobId}` }
        );
        published.push({
            jobId: job.jobId,
            queued: result.queued,
            messageId: result.messageId,
        });
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
                    lichessUsername: true,
                    chesscomUsername: true,
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

    try {
        const prefs = mergePreferences(
            defaultPreferences(),
            (job.user.preferences ?? {}) as PartialPreferences
        );
        const result = await syncUserProvider({
            user: job.user,
            provider: job.provider,
            prefs,
            rawPreferences: job.user.preferences,
            lichessAccessToken: job.user.accounts[0]?.access_token ?? null,
        });
        if (result.error) {
            await retryOrFailSyncJob({ job, error: result.error, now });
            return { jobId: job.id, provider: job.provider, result };
        }
        await prisma.syncJob.update({
            where: { id: job.id },
            data: {
                status: result.error ? 'FAILED' : 'SUCCEEDED',
                completedAt: new Date(),
                lockedUntil: null,
                lastError: result.error?.slice(0, 2_000) ?? null,
                fetchedCount: result.fetched,
                savedCount: result.saved,
                createdCount: result.created,
                updatedCount: result.updated,
                queuedAnalysisCount: result.queuedAnalysis,
            },
        });
        return { jobId: job.id, provider: job.provider, result };
    } catch (error) {
        await retryOrFailSyncJob({
            job,
            error,
            now,
        });
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
                queuedAnalysis: 0,
                skipped: false,
                error: errorMessage(error),
            },
        };
    }
}

async function planUserProviderSyncJob(args: {
    user: SyncJobUser;
    provider: Provider;
    scheduledFor: Date;
    now: Date;
}): Promise<PlannedSyncJob> {
    const username = providerUsername(args.provider, args.user);
    if (!username) return skipped(args.user.id, args.provider, 'unlinked');

    const prefs = mergePreferences(
        defaultPreferences(),
        (args.user.preferences ?? {}) as PartialPreferences
    );
    const state = args.user.providerSyncStates?.find(
        (item) => item.provider === args.provider
    );
    if (!autoSyncEnabledForProvider(prefs, args.provider, state?.enabled ?? true)) {
        return skipped(args.user.id, args.provider, 'disabled');
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

function skipped(
    userId: string,
    provider: Provider,
    skippedReason: string
): PlannedSyncJob {
    return { userId, provider, queued: false, jobId: null, skippedReason };
}

function providerUsername(
    provider: Provider,
    user: { lichessUsername: string | null; chesscomUsername: string | null }
) {
    return provider === 'LICHESS'
        ? user.lichessUsername
        : user.chesscomUsername;
}

function autoSyncEnabledForProvider(
    prefs: ReturnType<typeof mergePreferences>,
    provider: Provider,
    stateEnabled: boolean
) {
    if (!prefs.autoSyncEnabled) return false;
    if (!stateEnabled) return false;
    return !!prefs.autoSyncProviders[
        provider === 'LICHESS' ? 'lichess' : 'chesscom'
    ];
}

async function recoverExpiredSyncJobForProvider(args: {
    userId: string;
    provider: Provider;
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
        await prisma.syncJob.update({
            where: { id: job.id },
            data: {
                status: 'FAILED',
                lockedUntil: null,
                completedAt: args.now,
                lastError: 'Sync job lease expired after maximum attempts',
            },
        });
        return null;
    }

    return prisma.syncJob.update({
        where: { id: job.id },
        data: {
            status: 'QUEUED',
            scheduledFor: syncRetryScheduledFor({
                attempts: Math.max(1, job.attempts),
                now: args.now,
            }),
            startedAt: null,
            completedAt: null,
            lockedUntil: null,
            lastError: 'Sync job lease expired and was requeued',
        },
    });
}

async function retryOrFailSyncJob(args: {
    job: {
        id: string;
        attempts: number;
    };
    error: unknown;
    now: Date;
}) {
    const lastError = errorMessage(args.error).slice(0, 2_000);
    if (args.job.attempts < SYNC_JOB_MAX_ATTEMPTS) {
        return prisma.syncJob.update({
            where: { id: args.job.id },
            data: {
                status: 'QUEUED',
                scheduledFor: syncRetryScheduledFor({
                    attempts: Math.max(1, args.job.attempts),
                    now: args.now,
                }),
                startedAt: null,
                completedAt: null,
                lockedUntil: null,
                lastError,
            },
        });
    }

    return prisma.syncJob.update({
        where: { id: args.job.id },
        data: {
            status: 'FAILED',
            completedAt: args.now,
            lockedUntil: null,
            lastError,
        },
    });
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
