import { NextResponse } from 'next/server';

import { auth } from '@/lib/auth';
import { getPracticeInventorySummary } from '@/lib/training/practiceDue';

export const runtime = 'nodejs';

export async function GET() {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) {
        return NextResponse.json(
            { error: 'Unauthorized', code: 'UNAUTHORIZED' },
            { status: 401 }
        );
    }
    const practice = await getPracticeInventorySummary(userId);
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
