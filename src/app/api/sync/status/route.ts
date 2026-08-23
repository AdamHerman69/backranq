import { NextResponse } from 'next/server';

import { auth } from '@/lib/auth';
import {
    measureRequestPhase,
    withRequestTrace,
} from '@/lib/performance/requestTrace';
import { readSyncStatusSnapshot } from '@/lib/services/syncStatusRead';

export const runtime = 'nodejs';

export async function GET(request?: Request) {
    return withRequestTrace(
        { route: '/api/sync/status', request },
        buildSyncStatusResponse
    );
}

async function buildSyncStatusResponse() {
    const session = await measureRequestPhase('auth', () => auth());
    const userId = session?.user?.id;
    if (!userId) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const snapshot = await measureRequestPhase('status_snapshot', () =>
        readSyncStatusSnapshot(userId)
    );
    return NextResponse.json(snapshot);
}
