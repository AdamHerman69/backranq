import { NextResponse } from 'next/server';
import { runNotificationMaintenance } from '@/lib/notifications/campaigns';
import { dispatchPendingNotificationDeliveries } from '@/lib/notifications/delivery';
import { publishBackranqQueueMessage } from '@/lib/queues/backranq';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET(req: Request) {
    const secret = process.env.CRON_SECRET;
    if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const referenceAt = new Date();
    const since = new Date(referenceAt.getTime() - 7 * 24 * 60 * 60_000);
    const queuedMaintenance = await publishBackranqQueueMessage(
        {
            type: 'notification-maintenance',
            referenceAt: referenceAt.toISOString(),
            since: since.toISOString(),
        },
        {
            idempotencyKey: `notification-maintenance:initial:${referenceAt
                .toISOString()
                .slice(0, 10)}`,
            retentionSeconds: 7 * 24 * 60 * 60,
        }
    );
    const inlineMaintenance = queuedMaintenance.queued
        ? null
        : await runNotificationMaintenance({ referenceAt, since });
    const deliveries = await dispatchPendingNotificationDeliveries(100);
    return NextResponse.json({
        ok: true,
        maintenanceQueued: queuedMaintenance.queued,
        maintenance: inlineMaintenance,
        deliveries: deliveries.length,
    });
}
