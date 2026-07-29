import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import {
    InvalidTrainingCursorError,
    listTrainingSession,
} from '@/lib/training/readService';
import { parseTrainingSessionRequest } from '@/lib/training/apiValidation';
import type { TrainingApiErrorResponse } from '@/lib/training/api';
import {
    defaultPreferences,
    mergePreferences,
    trainingSourceKindsForSessionMix,
    type PartialPreferences,
} from '@/lib/preferences';

export const runtime = 'nodejs';

export async function GET(req: Request) {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) {
        return NextResponse.json<TrainingApiErrorResponse>(
            { error: 'Unauthorized', code: 'UNAUTHORIZED' },
            { status: 401 }
        );
    }
    const request = parseTrainingSessionRequest(new URL(req.url));
    if (!request) {
        return NextResponse.json<TrainingApiErrorResponse>(
            { error: 'Invalid training session query', code: 'INVALID_REQUEST' },
            { status: 400 }
        );
    }
    try {
        if (
            !request.cursor &&
            !request.filters?.sourceKinds?.length
        ) {
            const user = await prisma.user.findUnique({
                where: { id: userId },
                select: { preferences: true },
            });
            const preferences = mergePreferences(
                defaultPreferences(),
                (user?.preferences ?? {}) as PartialPreferences
            );
            const sourceKinds = trainingSourceKindsForSessionMix(
                preferences.trainingSessionMix
            );
            if (sourceKinds.length > 0) {
                request.filters = {
                    ...request.filters,
                    sourceKinds,
                };
            }
        }
        return NextResponse.json(
            await listTrainingSession({
                db: prisma,
                userId,
                request,
            }),
            {
                headers: {
                    'Cache-Control': 'private, no-store',
                },
            }
        );
    } catch (error) {
        if (error instanceof InvalidTrainingCursorError) {
            return NextResponse.json<TrainingApiErrorResponse>(
                { error: error.message, code: 'INVALID_REQUEST' },
                { status: 400 }
            );
        }
        throw error;
    }
}
