#!/usr/bin/env node
import { PrismaClient } from '@prisma/client';
import { loadEnvFiles } from './lib/load-env.mjs';

loadEnvFiles();

const prisma = new PrismaClient();

try {
    const [accounts, jobs, entries] = await Promise.all([
        prisma.billingAccount.findMany({
            select: {
                userId: true,
                serverCreditsBalance: true,
                monthlyServerCreditsUsed: true,
                monthlyServerCreditsLimit: true,
            },
        }),
        prisma.analysisJob.findMany({
            select: {
                id: true,
                status: true,
                userId: true,
                gameId: true,
                analysisRunId: true,
            },
        }),
        prisma.creditLedgerEntry.findMany({
            select: {
                userId: true,
                analysisJobId: true,
                analysisRunId: true,
                gameId: true,
                type: true,
                credits: true,
            },
        }),
    ]);

    const anomalies = [];
    for (const account of accounts) {
        if (account.serverCreditsBalance < 0) {
            anomalies.push(`user ${account.userId}: negative server credit balance`);
        }
        if (account.monthlyServerCreditsUsed > account.monthlyServerCreditsLimit) {
            anomalies.push(`user ${account.userId}: monthly usage exceeds limit`);
        }
    }

    const ledgerByJob = new Map();
    for (const entry of entries) {
        if (!entry.analysisJobId) continue;
        const current = ledgerByJob.get(entry.analysisJobId) ?? emptySummary();
        current[entry.type] += entry.credits;
        ledgerByJob.set(entry.analysisJobId, current);
    }

    for (const job of jobs) {
        const summary = ledgerByJob.get(job.id) ?? emptySummary();
        const outstanding =
            summary.RESERVED - summary.CONSUMED - summary.RELEASED - summary.EXPIRED;
        const netConsumed = summary.CONSUMED - summary.REFUNDED;
        if (outstanding < 0) {
            anomalies.push(`job ${job.id}: returned/consumed more credits than reserved`);
        }
        if (netConsumed < 0) {
            anomalies.push(`job ${job.id}: refunded more credits than consumed`);
        }
        if ((job.status === 'QUEUED' || job.status === 'RUNNING') && outstanding <= 0) {
            anomalies.push(`job ${job.id}: active job has no outstanding reservation`);
        }
        if (
            (job.status === 'FAILED' ||
                job.status === 'CANCELLED' ||
                job.status === 'SUCCEEDED') &&
            outstanding > 0
        ) {
            anomalies.push(`job ${job.id}: terminal job still has outstanding reservation`);
        }
    }

    console.log(
        JSON.stringify(
            {
                ok: anomalies.length === 0,
                accounts: accounts.length,
                jobs: jobs.length,
                ledgerEntries: entries.length,
                anomalies,
            },
            null,
            2
        )
    );
    process.exit(anomalies.length === 0 ? 0 : 1);
} finally {
    await prisma.$disconnect();
}

function emptySummary() {
    return {
        RESERVED: 0,
        CONSUMED: 0,
        REFUNDED: 0,
        RELEASED: 0,
        EXPIRED: 0,
    };
}
