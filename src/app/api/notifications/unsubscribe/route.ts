import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { verifyUnsubscribeToken } from '@/lib/notifications/tokens';

export const runtime = 'nodejs';

async function unsubscribe(req: Request) {
    const token = new URL(req.url).searchParams.get('token') ?? '';
    const userId = verifyUnsubscribeToken(token);
    if (!userId) return null;
    const unsubscribedAt = new Date();
    await prisma.$transaction(async (tx) => {
        await tx.notificationPreference.upsert({
            where: { userId },
            create: {
                userId,
                emailPracticeReady: false,
                emailAnalysisFailed: false,
                emailSyncSummary: false,
                emailWeeklyProgress: false,
                emailProductNews: false,
                optionalEmailsUnsubscribedAt: unsubscribedAt,
            },
            update: {
                emailPracticeReady: false,
                emailAnalysisFailed: false,
                emailSyncSummary: false,
                emailWeeklyProgress: false,
                emailProductNews: false,
                optionalEmailsUnsubscribedAt: unsubscribedAt,
            },
        });
        await tx.notificationDelivery.updateMany({
            where: {
                userId,
                channel: 'EMAIL',
                status: { in: ['PENDING', 'QUEUED'] },
                notification: {
                    type: {
                        in: [
                            'PRACTICE_READY',
                            'PRACTICE_DUE',
                            'ANALYSIS_FAILED',
                            'SYNC_FAILED',
                            'NEW_GAMES_SYNCED',
                            'WEEKLY_PROGRESS',
                            'PRODUCT_NEWS',
                        ],
                    },
                },
            },
            data: {
                status: 'CANCELLED',
                dispatchToken: null,
                lockedUntil: null,
            },
        });
    });
    return userId;
}

export async function GET(req: Request) {
    const token = new URL(req.url).searchParams.get('token') ?? '';
    const ok = !!verifyUnsubscribeToken(token);
    return new NextResponse(
        `<!doctype html><html><body style="font-family:system-ui;padding:40px;max-width:640px;margin:auto"><h1>${ok ? 'Unsubscribe from optional emails?' : 'Invalid unsubscribe link'}</h1>${ok ? `<p>You will still receive essential account and billing messages.</p><form method="post" action="?token=${encodeURIComponent(token)}"><button style="padding:10px 16px">Unsubscribe</button></form>` : '<p>This link is invalid or expired.</p>'}</body></html>`,
        { status: ok ? 200 : 400, headers: { 'content-type': 'text/html; charset=utf-8' } }
    );
}

export async function POST(req: Request) {
    return NextResponse.json({ unsubscribed: !!(await unsubscribe(req)) });
}
