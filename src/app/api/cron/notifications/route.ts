import { NextResponse } from 'next/server';
import { runNotificationMaintenance } from '@/lib/notifications/campaigns';
import { dispatchPendingNotificationDeliveries } from '@/lib/notifications/delivery';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET(req: Request) {
    const secret = process.env.CRON_SECRET;
    if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { weekly, reconciled, continuationQueued } =
        await runNotificationMaintenance();
    const deliveries = await dispatchPendingNotificationDeliveries(100);
    return NextResponse.json({
        ok: true,
        weekly,
        reconciled,
        continuationQueued,
        deliveries: deliveries.length,
    });
}
