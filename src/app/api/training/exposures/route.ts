import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { boundedJsonBody } from '@/lib/api/validation';
import { prisma } from '@/lib/prisma';
import {
    parsePracticeExposureWrite,
    recordPracticeExposure,
} from '@/lib/training/exposure';

export const runtime = 'nodejs';

const MAX_EXPOSURE_BODY_BYTES = 4_096;

export async function POST(req: Request) {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) {
        return NextResponse.json(
            { error: 'Unauthorized', code: 'UNAUTHORIZED' },
            { status: 401 }
        );
    }
    const body = await boundedJsonBody(
        req,
        MAX_EXPOSURE_BODY_BYTES
    );
    if (!body.ok) {
        return NextResponse.json(
            { error: body.error, code: 'INVALID_REQUEST' },
            { status: body.status ?? 400 }
        );
    }
    const event = parsePracticeExposureWrite(body.value);
    if (!event) {
        return NextResponse.json(
            {
                error: 'Invalid Practice exposure event',
                code: 'INVALID_REQUEST',
            },
            { status: 400 }
        );
    }
    const result = await recordPracticeExposure({
        db: prisma,
        userId,
        event,
    });
    if (!result.ok) {
        return NextResponse.json(
            { error: 'Position not found', code: 'NOT_FOUND' },
            { status: 404 }
        );
    }
    return NextResponse.json(result, {
        status: 202,
        headers: { 'Cache-Control': 'private, no-store' },
    });
}
