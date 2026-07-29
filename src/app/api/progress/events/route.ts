import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { boundedJsonBody } from '@/lib/api/validation';
import { prisma } from '@/lib/prisma';
import {
    parseProgressAnalyticsWrite,
    recordProgressAnalyticsEvent,
} from '@/lib/progress/analytics';

export const runtime = 'nodejs';

const MAX_EVENT_BODY_BYTES = 4_096;

export async function POST(req: Request) {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) {
        return NextResponse.json(
            { error: 'Unauthorized', code: 'UNAUTHORIZED' },
            { status: 401 }
        );
    }

    const body = await boundedJsonBody(req, MAX_EVENT_BODY_BYTES);
    if (!body.ok) {
        return NextResponse.json(
            {
                error: body.error,
                code: 'INVALID_REQUEST',
            },
            { status: body.status ?? 400 }
        );
    }
    const event = parseProgressAnalyticsWrite(body.value);
    if (!event) {
        return NextResponse.json(
            {
                error: 'Invalid progress event',
                code: 'INVALID_REQUEST',
            },
            { status: 400 }
        );
    }

    return NextResponse.json(
        await recordProgressAnalyticsEvent({
            db: prisma,
            userId,
            event,
        }),
        {
            status: 202,
            headers: {
                'Cache-Control': 'private, no-store',
            },
        }
    );
}
