import { NextResponse } from 'next/server';
import type {
    TrainingApiErrorResponse,
    TrainingApiErrorCode,
} from '@/lib/training/api';
import { TrainingAttemptError } from '@/lib/training/attemptService';

export function trainingErrorResponse(
    error: string,
    code: TrainingApiErrorCode,
    status: number,
    retryAfterMs?: number
) {
    return NextResponse.json<TrainingApiErrorResponse>(
        {
            error,
            code,
            ...(retryAfterMs == null ? {} : { retryAfterMs }),
        },
        {
            status,
            headers: {
                'Cache-Control': 'private, no-store',
                ...(retryAfterMs == null
                    ? {}
                    : {
                          'Retry-After': String(
                              Math.max(1, Math.ceil(retryAfterMs / 1_000))
                          ),
                      }),
            },
        }
    );
}

export function trainingAttemptErrorResponse(error: unknown) {
    return error instanceof TrainingAttemptError
        ? trainingErrorResponse(
              error.message,
              error.code,
              error.status,
              error.retryAfterMs
          )
        : null;
}
