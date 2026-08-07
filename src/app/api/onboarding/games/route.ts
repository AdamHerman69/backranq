import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';

import { boundedJsonBody, isRecord } from '@/lib/api/validation';
import type {
    OnboardingGamesResponse,
    PublicChessIdentity,
} from '@/lib/onboarding/contracts';
import {
    consumeOnboardingRateLimit,
    onboardingRequestKeyHash,
} from '@/lib/onboarding/rateLimit';
import { fetchChessComGames } from '@/lib/providers/chesscom';
import { fetchLichessGames } from '@/lib/providers/lichess';
import { lookupProviderProfile } from '@/lib/providers/profileLookup';

export const runtime = 'nodejs';

const MAX_BODY_BYTES = 1_024;
const MAX_GAMES = 5;
const USERNAME_RE = /^[A-Za-z0-9_-]{1,32}$/;
const NO_STORE_HEADERS = { 'Cache-Control': 'private, no-store' };

function errorResponse(
    status: number,
    code: string,
    error: string,
    retryAfterSeconds?: number
) {
    return NextResponse.json(
        { code, error, retryable: status === 429 || status >= 500 },
        {
            status,
            headers: {
                ...NO_STORE_HEADERS,
                ...(retryAfterSeconds
                    ? { 'Retry-After': String(retryAfterSeconds) }
                    : {}),
            },
        }
    );
}

function parseIdentity(value: unknown): PublicChessIdentity | null {
    if (!isRecord(value)) return null;
    if (value.provider !== 'lichess' && value.provider !== 'chesscom') {
        return null;
    }
    if (typeof value.username !== 'string') return null;
    const username = value.username.trim();
    if (!USERNAME_RE.test(username)) return null;
    return {
        provider: value.provider,
        username:
            value.provider === 'chesscom' ? username.toLowerCase() : username,
    };
}

export async function POST(request: Request) {
    const rateLimit = await consumeOnboardingRateLimit({
        keyHash: onboardingRequestKeyHash(request, 'onboarding-games'),
        namespace: 'onboarding-games',
        limit: 8,
    });
    if (!rateLimit.allowed) {
        return errorResponse(
            429,
            'PROVIDER_RATE_LIMITED',
            'Too many profile requests. Try again shortly.',
            rateLimit.retryAfterSeconds
        );
    }

    const body = await boundedJsonBody(request, MAX_BODY_BYTES);
    if (!body.ok) {
        return errorResponse(
            body.status ?? 400,
            'INVALID_USERNAME',
            body.error
        );
    }
    const identity = parseIdentity(body.value);
    if (!identity) {
        return errorResponse(
            400,
            'INVALID_USERNAME',
            'Choose a provider and enter a valid public username.'
        );
    }
    const profile = await lookupProviderProfile(identity);
    if (profile.state === 'not-found') {
        return errorResponse(
            404,
            'PROFILE_NOT_FOUND',
            'We could not find that public chess profile.'
        );
    }
    if (profile.state === 'source-error') {
        return errorResponse(
            profile.httpStatus,
            profile.httpStatus === 429
                ? 'PROVIDER_RATE_LIMITED'
                : 'PROVIDER_UNAVAILABLE',
            profile.error
        );
    }

    try {
        const fetched =
            identity.provider === 'lichess'
                ? await fetchLichessGames({
                      username: identity.username,
                      filters: { max: MAX_GAMES },
                  })
                : await fetchChessComGames({
                      username: identity.username,
                      filters: { max: MAX_GAMES },
                  });
        const games = fetched.games
            .slice()
            .sort(
                (left, right) =>
                    new Date(right.playedAt).getTime() -
                    new Date(left.playedAt).getTime()
            )
            .slice(0, MAX_GAMES);
        return NextResponse.json(
            {
                requestId: randomUUID(),
                identity,
                games,
            } satisfies OnboardingGamesResponse,
            { headers: NO_STORE_HEADERS }
        );
    } catch {
        return errorResponse(
            502,
            'PROVIDER_UNAVAILABLE',
            'The chess provider is temporarily unavailable. The warm-up puzzle still works.'
        );
    }
}
