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
            totalEligibleCount: practice?.totalEligibleCount ?? 0,
            dueCount: practice?.dueCount ?? 0,
            earliestDueAt:
                practice?.earliestDueAt?.toISOString() ?? null,
        },
        { headers: { 'Cache-Control': 'private, no-store' } }
    );
}
