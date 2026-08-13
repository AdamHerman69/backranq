import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import {
    NOTIFICATION_MAX_PAGE_SIZE,
    NOTIFICATION_PAGE_SIZE,
    notificationDto,
} from '@/lib/notifications/contracts';
import { boundedJsonBody, isRecord } from '@/lib/api/validation';
import {
    EXPECTED_OWNER_HEADER,
    expectedOwnerId,
} from '@/lib/auth/ownerContract';

export const runtime = 'nodejs';
const MAX_BODY_BYTES = 8_192;
const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(req: Request) {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const url = new URL(req.url);
    const rawLimit = url.searchParams.get('limit');
    const limit = rawLimit === null ? NOTIFICATION_PAGE_SIZE : Number(rawLimit);
    if (
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > NOTIFICATION_MAX_PAGE_SIZE
    ) {
        return NextResponse.json(
            {
                error: `limit must be an integer between 1 and ${NOTIFICATION_MAX_PAGE_SIZE}`,
            },
            { status: 400 }
        );
    }
    const cursor = url.searchParams.get('cursor');
    const [items, unreadCount] = await Promise.all([
        prisma.notification.findMany({
            where: { userId, archivedAt: null },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: limit + 1,
            ...(cursor && UUID_PATTERN.test(cursor)
                ? { cursor: { id: cursor }, skip: 1 }
                : {}),
        }),
        prisma.notification.count({
            where: { userId, readAt: null, archivedAt: null },
        }),
    ]);
    const hasMore = items.length > limit;
    const page = items.slice(0, limit);
    return NextResponse.json({
        ownerId: userId,
        notifications: page.map(notificationDto),
        unreadCount,
        nextCursor: hasMore ? page.at(-1)?.id ?? null : null,
    });
}
export async function POST(req: Request) {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (expectedOwnerId(req) !== userId) {
        return NextResponse.json(
            {
                error: `The signed-in account no longer matches ${EXPECTED_OWNER_HEADER}.`,
                code: 'OWNER_MISMATCH',
            },
            { status: 409 }
        );
    }
    const parsed = await boundedJsonBody(req, MAX_BODY_BYTES);
    if (!parsed.ok) {
        return NextResponse.json({ error: parsed.error }, { status: parsed.status ?? 400 });
    }
    if (!isRecord(parsed.value) || typeof parsed.value.action !== 'string') {
        return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }
    const now = new Date();
    if (parsed.value.action === 'mark-all-read') {
        const result = await prisma.notification.updateMany({
            where: { userId, readAt: null, archivedAt: null },
            data: { readAt: now },
        });
        return NextResponse.json({ ownerId: userId, updated: result.count });
    }
    if (
        parsed.value.action === 'mark-read' &&
        typeof parsed.value.id === 'string' &&
        UUID_PATTERN.test(parsed.value.id)
    ) {
        const result = await prisma.notification.updateMany({
            where: { id: parsed.value.id, userId, readAt: null },
            data: { readAt: now },
        });
        return NextResponse.json({ ownerId: userId, updated: result.count });
    }
    return NextResponse.json({ error: 'Unsupported action' }, { status: 400 });
}
