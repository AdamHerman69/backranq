import type { Provider } from '@prisma/client';
import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import {
    dispatchUserSyncJobs,
    getUserSyncActivity,
} from '@/lib/services/syncJobs';

export const runtime = 'nodejs';

const MAX_STALE_MINUTES = 7 * 24 * 60;
const MAX_REQUESTED_JOB_IDS = 4;
const MAX_JOB_ID_LENGTH = 128;

function providerFromInput(value: string): Provider | null {
    if (value === 'lichess') return 'LICHESS';
    if (value === 'chesscom') return 'CHESSCOM';
    return null;
}

function providerToOutput(provider: Provider) {
    return provider === 'LICHESS' ? 'lichess' : 'chesscom';
}

function parseBody(body: unknown):
    | {
          providers?: Provider[];
          onlyIfStaleMinutes?: number;
      }
    | { error: string } {
    if (body == null) return {};
    if (typeof body !== 'object' || Array.isArray(body)) {
        return { error: 'Invalid request body' };
    }
    const record = body as Record<string, unknown>;
    let providers: Provider[] | undefined;
    if (record.providers != null) {
        if (
            !Array.isArray(record.providers) ||
            record.providers.length > 2 ||
            record.providers.some((value) => typeof value !== 'string')
        ) {
            return { error: 'Invalid providers' };
        }
        providers = [];
        for (const value of record.providers as string[]) {
            const provider = providerFromInput(value);
            if (!provider) return { error: 'Invalid providers' };
            if (!providers.includes(provider)) providers.push(provider);
        }
        if (providers.length === 0) {
            return { error: 'Select at least one provider' };
        }
    }

    let onlyIfStaleMinutes: number | undefined;
    if (record.onlyIfStaleMinutes != null) {
        if (
            typeof record.onlyIfStaleMinutes !== 'number' ||
            !Number.isInteger(record.onlyIfStaleMinutes) ||
            record.onlyIfStaleMinutes < 0 ||
            record.onlyIfStaleMinutes > MAX_STALE_MINUTES
        ) {
            return { error: 'Invalid onlyIfStaleMinutes' };
        }
        onlyIfStaleMinutes = record.onlyIfStaleMinutes;
    }
    return { providers, onlyIfStaleMinutes };
}

async function userIdOrUnauthorized() {
    const session = await auth();
    return session?.user?.id ?? null;
}

function parseRequestedJobIds(req?: Request): string[] | { error: string } {
    if (!req) return [];
    const raw = new URL(req.url).searchParams.get('jobIds');
    if (raw == null) return [];
    if (!raw.trim()) return { error: 'Invalid jobIds' };
    const parts = raw.split(',');
    if (
        parts.some(
            (part) =>
                !part ||
                part.length > MAX_JOB_ID_LENGTH ||
                !/^[A-Za-z0-9_-]+$/.test(part)
        )
    ) {
        return { error: 'Invalid jobIds' };
    }
    const jobIds = Array.from(new Set(parts));
    if (jobIds.length > MAX_REQUESTED_JOB_IDS) {
        return { error: 'Too many jobIds' };
    }
    return jobIds;
}

export async function GET(req?: Request) {
    const userId = await userIdOrUnauthorized();
    if (!userId) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const requestedJobIds = parseRequestedJobIds(req);
    if ('error' in requestedJobIds) {
        return NextResponse.json(
            { error: requestedJobIds.error },
            { status: 400 }
        );
    }
    return NextResponse.json(
        requestedJobIds.length > 0
            ? await getUserSyncActivity(userId, { requestedJobIds })
            : await getUserSyncActivity(userId)
    );
}

export async function POST(req: Request) {
    const userId = await userIdOrUnauthorized();
    if (!userId) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    let body: unknown;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json(
            { error: 'Invalid request body' },
            { status: 400 }
        );
    }
    const parsed = parseBody(body);
    if ('error' in parsed) {
        return NextResponse.json({ error: parsed.error }, { status: 400 });
    }

    const result = await dispatchUserSyncJobs({
        userId,
        providers: parsed.providers,
        onlyIfStaleMinutes: parsed.onlyIfStaleMinutes,
    });
    const publishedByJobId = new Map(
        result.published.map((item) => [item.jobId, item])
    );
    const providers = result.providers.map((item) => {
        const published = item.jobId
            ? publishedByJobId.get(item.jobId)
            : undefined;
        return {
            provider: providerToOutput(item.provider),
            queued: item.queued,
            jobId: item.jobId,
            skippedReason: item.skippedReason,
            queuePublished: published?.queued ?? null,
            jobStatus: published?.jobStatus ?? null,
        };
    });

    return NextResponse.json({
        requested: providers.map((item) => item.provider),
        providers,
        active: await getUserSyncActivity(userId),
    });
}
