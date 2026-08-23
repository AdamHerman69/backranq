import { NextResponse } from 'next/server';

import { auth } from '@/lib/auth';
import { getPracticeInventorySummary } from '@/lib/training/practiceDue';
import {
    measureRequestPhase,
    withRequestTrace,
} from '@/lib/performance/requestTrace';

export const runtime = 'nodejs';

export async function GET(request?: Request) {
    return withRequestTrace(
        { route: '/api/training/due', request },
        dueResponse
    );
}

async function dueResponse() {
    const session = await measureRequestPhase('auth', () => auth());
    const userId = session?.user?.id;
    if (!userId) {
        return NextResponse.json(
            { error: 'Unauthorized', code: 'UNAUTHORIZED' },
            { status: 401 }
        );
    }
    const practice = await measureRequestPhase('inventory', () =>
        getPracticeInventorySummary(userId)
    );
    return NextResponse.json(
        {
            availableCount: practice?.availableCount ?? 0,
            availableCountIsExact:
                practice?.availableCountIsExact ?? true,
            dueCount: practice?.dueCount ?? 0,
            dueCountIsExact: practice?.dueCountIsExact ?? true,
            newCount: practice?.newCount ?? 0,
            newCountIsExact: practice?.newCountIsExact ?? true,
            earliestDueAt:
                practice?.earliestDueAt?.toISOString() ?? null,
        },
        { headers: { 'Cache-Control': 'private, no-store' } }
    );
}
