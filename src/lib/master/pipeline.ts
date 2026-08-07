import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';

import {
    weeklyMasterConfig,
    WEEKLY_MASTER_MAX_ATTEMPTS,
} from '@/lib/master/config';
import { masterContentHash } from '@/lib/master/ranking';
import { prisma } from '@/lib/prisma';
import { publishBackranqQueueMessage } from '@/lib/queues/backranq';

type PipelineClient = Pick<Prisma.TransactionClient, 'masterPipelineRun'>;
export type PipelineScope = 'FULL' | 'INGEST' | 'ANALYSIS';

export class MasterPipelineBusyError extends Error {
    constructor(readonly activeRunId: string) {
        super('Another Weekly Master pipeline run is already active');
        this.name = 'MasterPipelineBusyError';
    }
}

function dayKey(now: Date) {
    return now.toISOString().slice(0, 10);
}

export async function createMasterPipelineRun(
    tx: PipelineClient,
    args: {
        trigger: 'SCHEDULED' | 'ADMIN' | 'RETRY' | 'RECOVERY';
        scope?: PipelineScope;
        targetSourceGameId?: string;
        runKey?: string;
        scheduledFor?: Date;
        now?: Date;
    }
) {
    const now = args.now ?? new Date();
    const config = {
        ...weeklyMasterConfig(),
        scope: args.scope ?? 'FULL',
        targetSourceGameId: args.targetSourceGameId ?? null,
    };
    const configHash = masterContentHash(config);
    const runKey =
        args.runKey ??
        (args.trigger === 'SCHEDULED'
            ? `weekly-master:${dayKey(now)}`
            : `weekly-master:${args.trigger.toLowerCase()}:${randomUUID()}`);
    const existing = await tx.masterPipelineRun.findUnique({
        where: { runKey },
    });
    if (existing) {
        if (
            existing.status === 'FAILED' &&
            existing.attempts < WEEKLY_MASTER_MAX_ATTEMPTS
        ) {
            return tx.masterPipelineRun.update({
                where: { id: existing.id },
                data: {
                    status: 'QUEUED',
                    stage: 'SOURCE',
                    trigger: 'RETRY',
                    scheduledFor: args.scheduledFor ?? now,
                    lockedUntil: null,
                    leaseToken: null,
                    lastError: null,
                    completedAt: null,
                },
            });
        }
        return existing;
    }
    const active = await tx.masterPipelineRun.findFirst({
        where: { status: { in: ['QUEUED', 'RUNNING'] } },
        orderBy: { createdAt: 'asc' },
    });
    if (active) {
        if (args.trigger === 'SCHEDULED' || args.trigger === 'RECOVERY') {
            return active;
        }
        throw new MasterPipelineBusyError(active.id);
    }
    return tx.masterPipelineRun.create({
        data: {
            runKey,
            trigger: args.trigger,
            scheduledFor: args.scheduledFor ?? now,
            configSnapshot: config as unknown as Prisma.InputJsonValue,
            configHash,
        },
    });
}

export async function publishMasterPipelineRun(runId: string) {
    return publishBackranqQueueMessage(
        { type: 'weekly-master-run', runId },
        { idempotencyKey: `weekly-master-run:${runId}` }
    );
}

export async function planWeeklyMasterRun(args: {
    trigger?: 'SCHEDULED' | 'ADMIN' | 'RETRY' | 'RECOVERY';
    scope?: PipelineScope;
    targetSourceGameId?: string;
    force?: boolean;
    now?: Date;
} = {}) {
    const now = args.now ?? new Date();
    const trigger = args.trigger ?? 'SCHEDULED';
    const run = await prisma.$transaction((tx) =>
        createMasterPipelineRun(tx, {
            trigger,
            scope: args.scope,
            targetSourceGameId: args.targetSourceGameId,
            runKey: args.force
                ? `weekly-master:${trigger.toLowerCase()}:${randomUUID()}`
                : undefined,
            now,
        })
    );
    const published =
        run.status === 'QUEUED' ? await publishMasterPipelineRun(run.id) : null;
    return { run, published };
}
