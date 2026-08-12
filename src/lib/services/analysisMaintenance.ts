import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { publishBackranqQueueMessage } from '@/lib/queues/backranq';
import {
    reconcileAnalysisBatchCompletions,
    recoverAnalysisBatchPlanOutbox,
} from '@/lib/services/analysisBatches';
import { reconcileAnalysisCreditSettlements } from '@/lib/services/analysisOps';
import { flushAnalysisOutbox } from '@/lib/services/analysisOutbox';
import {
    dispatchQueuedAnalysisJobs,
    recoverExpiredAnalysisJobs,
} from '@/lib/services/analysisScheduler';

const MAINTENANCE_KEY = 'analysis-maintenance';
const MAINTENANCE_LEASE_MS = 2 * 60_000;
export const ANALYSIS_MAINTENANCE_INTERVAL_SECONDS = 60;

export async function runAnalysisMaintenanceHeartbeat(args: {
    now?: Date;
} = {}) {
    const now = args.now ?? new Date();
    const maintenance = await runAnalysisMaintenanceCycle({ now });
    const nextHeartbeat = await scheduleNextAnalysisMaintenance({ now });
    return { ...maintenance, nextHeartbeat };
}

export async function runAnalysisMaintenanceCycle(args: {
    now?: Date;
} = {}) {
    const now = args.now ?? new Date();
    const leaseToken = randomUUID();
    const acquired = await acquireMaintenanceLease({ leaseToken, now });
    if (!acquired) {
        return { skipped: 'already-running' as const };
    }

    try {
        const batchPlanRecovery = await recoverAnalysisBatchPlanOutbox();
        const recovery = await recoverExpiredAnalysisJobs({ now });
        const dispatch = await dispatchQueuedAnalysisJobs({ now });
        const batches = await reconcileAnalysisBatchCompletions();
        const settlements = await reconcileAnalysisCreditSettlements();
        const outbox = await flushAnalysisOutbox({ now });
        return {
            skipped: null,
            batchPlanRecovery,
            recovery,
            dispatch,
            batches,
            settlements,
            outbox,
        };
    } finally {
        await prisma.analysisMaintenanceLease
            .updateMany({
                where: { key: MAINTENANCE_KEY, leaseToken },
                data: { lockedUntil: new Date() },
            })
            .catch((error) => {
                console.error(
                    '[analysis maintenance] lease release failed',
                    error
                );
            });
    }
}

export async function scheduleNextAnalysisMaintenance(args: {
    now?: Date;
} = {}) {
    const now = args.now ?? new Date();
    const scheduledAt = new Date(
        now.getTime() + ANALYSIS_MAINTENANCE_INTERVAL_SECONDS * 1_000
    );
    const bucket = Math.floor(scheduledAt.getTime() / 60_000);
    const result = await publishBackranqQueueMessage(
        {
            type: 'analysis-maintenance',
            requestedAt: scheduledAt.toISOString(),
        },
        {
            idempotencyKey: `analysis-maintenance:${bucket}`,
            delaySeconds: ANALYSIS_MAINTENANCE_INTERVAL_SECONDS,
            retentionSeconds: 24 * 60 * 60,
        }
    );
    if (!result.queued) {
        throw new Error('Failed to schedule the next analysis maintenance', {
            cause: result.error ?? result.unavailableReason,
        });
    }
    return {
        queued: true as const,
        messageId: result.messageId,
        scheduledAt: scheduledAt.toISOString(),
    };
}

async function acquireMaintenanceLease(args: {
    leaseToken: string;
    now: Date;
}) {
    const lockedUntil = new Date(args.now.getTime() + MAINTENANCE_LEASE_MS);
    const rows = await prisma.$queryRaw<Array<{ leaseToken: string }>>(
        Prisma.sql`
            INSERT INTO "AnalysisMaintenanceLease"
                ("key", "leaseToken", "lockedUntil", "createdAt", "updatedAt")
            VALUES
                (${MAINTENANCE_KEY}, ${args.leaseToken}::uuid, ${lockedUntil}, ${args.now}, ${args.now})
            ON CONFLICT ("key") DO UPDATE
            SET "leaseToken" = EXCLUDED."leaseToken",
                "lockedUntil" = EXCLUDED."lockedUntil",
                "updatedAt" = EXCLUDED."updatedAt"
            WHERE "AnalysisMaintenanceLease"."lockedUntil" <= ${args.now}
            RETURNING "leaseToken"
        `
    );
    return rows[0]?.leaseToken === args.leaseToken;
}
