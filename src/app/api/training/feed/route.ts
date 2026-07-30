import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import {
    InvalidPracticeFeedCursorError,
    listPracticeFeed,
} from '@/lib/training/readService';
import { parsePracticeFeedRequest } from '@/lib/training/apiValidation';
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
    const request = parsePracticeFeedRequest(new URL(req.url));
    if (!request) {
        return NextResponse.json<TrainingApiErrorResponse>(
            { error: 'Invalid practice feed query', code: 'INVALID_REQUEST' },
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
            await listPracticeFeed({
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
        if (error instanceof InvalidPracticeFeedCursorError) {
            return NextResponse.json<TrainingApiErrorResponse>(
                { error: error.message, code: 'INVALID_REQUEST' },
                { status: 400 }
            );
        }
        throw error;
    }
}
