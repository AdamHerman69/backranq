import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
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

export async function runAnalysisMaintenanceCycle(args: {
    now?: Date;
} = {}) {
    const now = args.now ?? new Date();
    const leaseToken = randomUUID();
    const acquired = await acquireMaintenanceLease({ leaseToken, now });
    if (!acquired) {
        return { skipped: 'already-running' as const };
    }

    // The lease expires before the next scheduled cycle. Leaving it to expire
    // avoids a second unconditional write while still fencing duplicate cron
    // delivery and recovering automatically after a hard crash.
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
