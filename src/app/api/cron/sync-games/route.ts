import { NextResponse } from 'next/server';
import { publishBackranqQueueMessage } from '@/lib/queues/backranq';
import { dispatchQueuedAnalysisJobs } from '@/lib/services/analysisScheduler';
import { planAndProcessDueSyncJobsInline } from '@/lib/services/syncJobs';

export const runtime = 'nodejs';
export const maxDuration = 60;

function authorized(req: Request) {
    const cronSecret = process.env.CRON_SECRET;
    const authHeader = req.headers.get('authorization');
    return !!cronSecret && authHeader === `Bearer ${cronSecret}`;
}

export async function GET(req: Request) {
    if (!authorized(req)) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const queued = await publishBackranqQueueMessage(
        { type: 'sync-all', requestedAt: new Date().toISOString() },
        { idempotencyKey: `sync-all:${new Date().toISOString().slice(0, 13)}` }
    );

    if (queued.queued) {
        return NextResponse.json({
            ok: true,
            queued: true,
            messageId: queued.messageId,
        });
    }

    const result = await planAndProcessDueSyncJobsInline();
    const dispatch = await dispatchQueuedAnalysisJobs();
    return NextResponse.json({ ok: true, queued: false, result, dispatch });
}
