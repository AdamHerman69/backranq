import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { boundedJsonBody } from '@/lib/api/validation';
import { prisma } from '@/lib/prisma';
import { revealTrainingMoment } from '@/lib/training/attemptService';
import type { TrainingApiErrorResponse } from '@/lib/training/api';
import {
    isTrainingApiUuid,
    MAX_TRAINING_API_BODY_BYTES,
    parseRevealTrainingMomentRequest,
} from '@/lib/training/apiValidation';
import {
    trainingAttemptErrorResponse,
    trainingErrorResponse,
} from '@/lib/training/routeResponses';

export const runtime = 'nodejs';

export async function POST(
    req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) {
        return trainingErrorResponse(
            'Unauthorized',
            'UNAUTHORIZED',
            401
        );
    }

    const { id } = await params;
    if (!isTrainingApiUuid(id)) {
        return trainingErrorResponse('Not found', 'NOT_FOUND', 404);
    }
    const body = await boundedJsonBody(
        req,
        MAX_TRAINING_API_BODY_BYTES
    );
    if (!body.ok) {
        return NextResponse.json<TrainingApiErrorResponse>(
            { error: body.error, code: 'INVALID_REQUEST' },
            { status: body.status ?? 400 }
        );
    }
    const request = parseRevealTrainingMomentRequest(body.value);
    if (!request) {
        return trainingErrorResponse(
            'Invalid reveal request',
            'INVALID_REQUEST',
            400
        );
    }

    try {
        return NextResponse.json(
            await revealTrainingMoment({
                userId,
                momentId: id,
                request,
                dependencies: { db: prisma },
            }),
            {
                headers: {
                    'Cache-Control': 'private, no-store',
                },
            }
        );
    } catch (error) {
        const response = trainingAttemptErrorResponse(error);
        if (response) return response;
        throw error;
    }
}
