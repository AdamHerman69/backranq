import { NextResponse } from 'next/server';
import { runAnalysisMaintenanceHeartbeat } from '@/lib/services/analysisMaintenance';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET(req: Request) {
    const secret = process.env.CRON_SECRET;
    if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    return NextResponse.json({
        ok: true,
        ...(await runAnalysisMaintenanceHeartbeat()),
    });
}
