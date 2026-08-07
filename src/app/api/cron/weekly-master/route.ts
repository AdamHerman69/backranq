import { NextResponse } from 'next/server';
import { planWeeklyMasterRun } from '@/lib/master/pipeline';
import {
    markStaleMasterPublications,
    revalidateSelectedMasterSources,
} from '@/lib/master/publication';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const maxDuration = 60;

function authorized(req: Request) {
    const secret = process.env.CRON_SECRET;
    return (
        !!secret && req.headers.get('authorization') === `Bearer ${secret}`
    );
}

export async function GET(req: Request) {
    if (!authorized(req)) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const now = new Date();
    const [planned, sourceHealth, rateBuckets, analyticsEvents] =
        await Promise.all([
            planWeeklyMasterRun({ trigger: 'SCHEDULED', now }),
            revalidateSelectedMasterSources(now),
            prisma.onboardingRateBucket.deleteMany({
                where: {
                    updatedAt: {
                        lt: new Date(now.getTime() - 2 * 86_400_000),
                    },
                },
            }),
            prisma.onboardingAnalyticsEvent.deleteMany({
                where: {
                    recordedAt: {
                        lt: new Date(now.getTime() - 180 * 86_400_000),
                    },
                },
            }),
        ]);
    const stale = await markStaleMasterPublications(now);
    return NextResponse.json(
        {
            ok: true,
            runId: planned.run.id,
            status: planned.run.status,
            queuePublished: planned.published?.queued ?? null,
            stalePublications: stale.count,
            sourceHealth,
            deletedRateBuckets: rateBuckets.count,
            deletedAnalyticsEvents: analyticsEvents.count,
        },
        { status: 202 }
    );
}
