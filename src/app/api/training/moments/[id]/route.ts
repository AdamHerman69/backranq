import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import type { TrainingApiErrorResponse } from '@/lib/training/api';
import { isTrainingApiUuid } from '@/lib/training/apiValidation';
import { getTrainingMomentPrompt } from '@/lib/training/readService';

export const runtime = 'nodejs';

export async function GET(
    _req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) {
        return NextResponse.json<TrainingApiErrorResponse>(
            { error: 'Unauthorized', code: 'UNAUTHORIZED' },
            { status: 401 }
        );
    }
    const { id } = await params;
    if (!isTrainingApiUuid(id)) {
        return NextResponse.json<TrainingApiErrorResponse>(
            { error: 'Not found', code: 'NOT_FOUND' },
            { status: 404 }
        );
    }
    const result = await getTrainingMomentPrompt({
        db: prisma,
        userId,
        momentId: id,
    });
    if (!result) {
        return NextResponse.json<TrainingApiErrorResponse>(
            { error: 'Not found', code: 'NOT_FOUND' },
            { status: 404 }
        );
    }
    return NextResponse.json(result, {
        headers: { 'Cache-Control': 'private, no-store' },
    });
}
