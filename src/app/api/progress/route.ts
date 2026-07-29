import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import {
    getProgressSnapshot,
    ProgressDatasetTooLargeError,
    ProgressUserNotFoundError,
} from '@/lib/progress/readService';
import { parseProgressRequest } from '@/lib/progress/query';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE_HEADERS = {
    'Cache-Control': 'private, no-store',
};

export async function GET(req: Request) {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) {
        return NextResponse.json(
            { error: 'Unauthorized', code: 'UNAUTHORIZED' },
            { status: 401, headers: NO_STORE_HEADERS }
        );
    }

    const request = parseProgressRequest(new URL(req.url));
    if (!request) {
        return NextResponse.json(
            {
                error: 'Invalid progress query',
                code: 'INVALID_REQUEST',
            },
            { status: 400, headers: NO_STORE_HEADERS }
        );
    }

    try {
        return NextResponse.json(
            await getProgressSnapshot({
                userId,
                ...request,
            }),
            {
                headers: NO_STORE_HEADERS,
            }
        );
    } catch (error) {
        if (error instanceof ProgressUserNotFoundError) {
            return NextResponse.json(
                { error: 'User not found', code: 'NOT_FOUND' },
                { status: 404, headers: NO_STORE_HEADERS }
            );
        }
        if (error instanceof ProgressDatasetTooLargeError) {
            return NextResponse.json(
                {
                    error: 'Progress cannot safely assemble this retained dataset yet',
                    code: 'DATASET_TOO_LARGE',
                    dataset: error.dataset,
                },
                { status: 422, headers: NO_STORE_HEADERS }
            );
        }
        throw error;
    }
}
