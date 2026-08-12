import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import {
    dispatchQueuedAnalysisJobs,
    recoverExpiredAnalysisJobs,
} from '@/lib/services/analysisScheduler';
import { flushAnalysisOutbox } from '@/lib/services/analysisOutbox';
import { reconcileAnalysisCreditSettlements } from '@/lib/services/analysisOps';
import {
    reconcileAnalysisBatchCompletions,
    recoverAnalysisBatchPlanOutbox,
} from '@/lib/services/analysisBatches';

export const runtime = 'nodejs';
export const maxDuration = 60;
const MAINTENANCE_KEY = 'analysis-maintenance';
const MAINTENANCE_LEASE_MS = 2 * 60_000;

export async function GET(req: Request) {
    const secret = process.env.CRON_SECRET;
    if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const leaseToken = randomUUID();
    const acquired = await acquireMaintenanceLease(leaseToken);
    if (!acquired) {
        return NextResponse.json({ ok: true, skipped: 'already-running' });
    }

    try {
        const batchPlanRecovery = await recoverAnalysisBatchPlanOutbox();
        const recovery = await recoverExpiredAnalysisJobs();
        const dispatch = await dispatchQueuedAnalysisJobs();
        const batches = await reconcileAnalysisBatchCompletions();
        const settlements = await reconcileAnalysisCreditSettlements();
        const outbox = await flushAnalysisOutbox();
        return NextResponse.json({
            ok: true,
            skipped: null,
            batchPlanRecovery,
            recovery,
            dispatch,
            batches,
            settlements,
            outbox,
        });
    } finally {
        await prisma.analysisMaintenanceLease.updateMany({
            where: { key: MAINTENANCE_KEY, leaseToken },
            data: { lockedUntil: new Date() },
        }).catch((error) => {
            console.error('[analysis maintenance] lease release failed', error);
        });
    }
}

async function acquireMaintenanceLease(leaseToken: string) {
    const now = new Date();
    const lockedUntil = new Date(now.getTime() + MAINTENANCE_LEASE_MS);
    const rows = await prisma.$queryRaw<Array<{ leaseToken: string }>>(
        Prisma.sql`
            INSERT INTO "AnalysisMaintenanceLease"
                ("key", "leaseToken", "lockedUntil", "createdAt", "updatedAt")
            VALUES
                (${MAINTENANCE_KEY}, ${leaseToken}::uuid, ${lockedUntil}, ${now}, ${now})
            ON CONFLICT ("key") DO UPDATE
            SET "leaseToken" = EXCLUDED."leaseToken",
                "lockedUntil" = EXCLUDED."lockedUntil",
                "updatedAt" = EXCLUDED."updatedAt"
            WHERE "AnalysisMaintenanceLease"."lockedUntil" <= ${now}
            RETURNING "leaseToken"
        `
    );
    return rows[0]?.leaseToken === leaseToken;
}
