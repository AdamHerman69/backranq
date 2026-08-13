import { NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import { auth } from '@/lib/auth';
import { boundedJsonBody, isRecord } from '@/lib/api/validation';
import { getOrCreateNotificationPreference } from '@/lib/notifications/service';
import { preferenceDto } from '@/lib/notifications/contracts';
import { prisma } from '@/lib/prisma';
import {
    EXPECTED_OWNER_HEADER,
    expectedOwnerId,
} from '@/lib/auth/ownerContract';

export const runtime = 'nodejs';
const MAX_BODY_BYTES = 16_384;
const BOOLEAN_KEYS = [
    'emailPracticeReady',
    'emailAnalysisFailed',
    'emailSyncSummary',
    'emailBilling',
    'emailWeeklyProgress',
    'pushEnabled',
] as const;

export async function GET() {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const preference = await getOrCreateNotificationPreference(userId);
    return NextResponse.json({
        ownerId: userId,
        preferences: preferenceDto(preference),
        vapidPublicKey: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? null,
    });
}

export async function PATCH(req: Request) {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (expectedOwnerId(req) !== userId) {
        return NextResponse.json(
            {
                error: `The signed-in account no longer matches ${EXPECTED_OWNER_HEADER}. Reload Settings before saving.`,
            },
            { status: 409 }
        );
    }
    const parsed = await boundedJsonBody(req, MAX_BODY_BYTES);
    if (!parsed.ok) {
        return NextResponse.json({ error: parsed.error }, { status: parsed.status ?? 400 });
    }
    if (!isRecord(parsed.value)) {
        return NextResponse.json({ error: 'Invalid preferences' }, { status: 400 });
    }
    const value = parsed.value;
    const allowed = new Set([
        ...BOOLEAN_KEYS,
        'emailProductNews',
        'syncDigestFrequency',
        'timezone',
        'digestHour',
    ]);
    const unknown = Object.keys(parsed.value).find((key) => !allowed.has(key));
    if (unknown) {
        return NextResponse.json({ error: `Unknown preference: ${unknown}` }, { status: 400 });
    }
    const data: Prisma.NotificationPreferenceUpdateInput = {};
    for (const key of BOOLEAN_KEYS) {
        if (key in parsed.value) {
            if (typeof parsed.value[key] !== 'boolean') {
                return NextResponse.json({ error: `Invalid ${key}` }, { status: 400 });
            }
            data[key] = parsed.value[key];
        }
    }
    if ('emailProductNews' in parsed.value) {
        if (typeof parsed.value.emailProductNews !== 'boolean') {
            return NextResponse.json({ error: 'Invalid emailProductNews' }, { status: 400 });
        }
        data.emailProductNews = parsed.value.emailProductNews;
        data.productNewsConsentedAt = parsed.value.emailProductNews ? new Date() : null;
    }
    if ('syncDigestFrequency' in parsed.value) {
        if (!['OFF', 'DAILY', 'WEEKLY'].includes(String(parsed.value.syncDigestFrequency))) {
            return NextResponse.json({ error: 'Invalid syncDigestFrequency' }, { status: 400 });
        }
        data.syncDigestFrequency = String(parsed.value.syncDigestFrequency) as 'OFF' | 'DAILY' | 'WEEKLY';
    }
    if ('timezone' in parsed.value) {
        if (typeof parsed.value.timezone !== 'string' || !validTimezone(parsed.value.timezone)) {
            return NextResponse.json({ error: 'Invalid timezone' }, { status: 400 });
        }
        data.timezone = parsed.value.timezone;
    }
    if ('digestHour' in parsed.value) {
        if (!Number.isSafeInteger(parsed.value.digestHour) || Number(parsed.value.digestHour) < 0 || Number(parsed.value.digestHour) > 23) {
            return NextResponse.json({ error: 'Invalid digestHour' }, { status: 400 });
        }
        data.digestHour = Number(parsed.value.digestHour);
    }
    if (Object.keys(data).length === 0) {
        return NextResponse.json({ error: 'No preferences supplied' }, { status: 400 });
    }
    const preference = await prisma.$transaction(async (tx) => {
        await getOrCreateNotificationPreference(userId, tx);
        const updated = await tx.notificationPreference.update({
            where: { userId },
            data: {
                ...data,
                optionalEmailsUnsubscribedAt:
                    data.emailPracticeReady === true ||
                    data.emailAnalysisFailed === true ||
                    data.emailProductNews === true ||
                    data.emailWeeklyProgress === true ||
                    data.emailSyncSummary === true
                        ? null
                        : undefined,
            },
        });
        const cancelledEmailTypes = disabledEmailTypes(value);
        if (cancelledEmailTypes.length > 0) {
            await tx.notificationDelivery.updateMany({
                where: {
                    userId,
                    channel: 'EMAIL',
                    status: { in: ['PENDING', 'QUEUED'] },
                    notification: { type: { in: cancelledEmailTypes } },
                },
                data: {
                    status: 'CANCELLED',
                    dispatchToken: null,
                    lockedUntil: null,
                },
            });
        }
        if (value.pushEnabled === false) {
            await tx.notificationDelivery.updateMany({
                where: {
                    userId,
                    channel: 'WEB_PUSH',
                    status: { in: ['PENDING', 'QUEUED'] },
                },
                data: {
                    status: 'CANCELLED',
                    dispatchToken: null,
                    lockedUntil: null,
                },
            });
        }
        return updated;
    });
    return NextResponse.json({
        ownerId: userId,
        preferences: preferenceDto(preference),
    });
}

function disabledEmailTypes(value: Record<string, unknown>) {
    const types: Array<
        | 'PRACTICE_READY'
        | 'PRACTICE_DUE'
        | 'ANALYSIS_FAILED'
        | 'SYNC_FAILED'
        | 'NEW_GAMES_SYNCED'
        | 'LOW_CREDITS'
        | 'BILLING_ACTION_REQUIRED'
        | 'WEEKLY_PROGRESS'
        | 'PRODUCT_NEWS'
    > = [];
    if (value.emailPracticeReady === false) {
        types.push('PRACTICE_READY', 'PRACTICE_DUE');
    }
    if (value.emailAnalysisFailed === false) {
        types.push('ANALYSIS_FAILED', 'SYNC_FAILED');
    }
    if (value.emailSyncSummary === false || value.syncDigestFrequency === 'OFF') {
        types.push('NEW_GAMES_SYNCED');
    }
    if (value.emailBilling === false) {
        types.push('LOW_CREDITS', 'BILLING_ACTION_REQUIRED');
    }
    if (value.emailWeeklyProgress === false) types.push('WEEKLY_PROGRESS');
    if (value.emailProductNews === false) types.push('PRODUCT_NEWS');
    return types;
}

function validTimezone(value: string) {
    if (value.length < 1 || value.length > 100) return false;
    try {
        new Intl.DateTimeFormat('en', { timeZone: value }).format();
        return true;
    } catch {
        return false;
    }
}
