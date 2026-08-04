import { NextResponse } from 'next/server';
import {
    generateDueWeeklyProgressNotifications,
    reconcileRecentNotificationEvents,
} from '@/lib/notifications/campaigns';
import { dispatchPendingNotificationDeliveries } from '@/lib/notifications/delivery';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET(req: Request) {
    const secret = process.env.CRON_SECRET;
    if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const [weekly, reconciled] = await Promise.all([
        generateDueWeeklyProgressNotifications(),
        reconcileRecentNotificationEvents(),
    ]);
    const deliveries = await dispatchPendingNotificationDeliveries(100);
    return NextResponse.json({
        ok: true,
        weekly,
        reconciled,
        deliveries: deliveries.length,
    });
}
