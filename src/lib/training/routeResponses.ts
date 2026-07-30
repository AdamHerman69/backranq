import { NextResponse } from 'next/server';
import type {
    TrainingApiErrorResponse,
    TrainingApiErrorCode,
} from '@/lib/training/api';
import { TrainingAttemptError } from '@/lib/training/attemptService';

export function trainingErrorResponse(
    error: string,
    code: TrainingApiErrorCode,
    status: number
) {
    return NextResponse.json<TrainingApiErrorResponse>(
        {
            error,
            code,
        },
        {
            status,
            headers: {
                'Cache-Control': 'private, no-store',
            },
        }
    );
}

export function trainingAttemptErrorResponse(error: unknown) {
    return error instanceof TrainingAttemptError
        ? trainingErrorResponse(
              error.message,
              error.code,
              error.status
          )
        : null;
}
