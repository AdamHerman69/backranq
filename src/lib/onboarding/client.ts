import type { TrainingPromptDto } from '@/lib/training/api';

import type { OnboardingAnalyticsEvent } from './analytics';
import type {
    LandingPuzzleDto,
    OnboardingGamesResponse,
    OnboardingSearchError,
    PublicChessIdentity,
} from './contracts';
import { WARMUP_PUZZLE } from './warmupPuzzle';

export class OnboardingClientError extends Error {
    constructor(
        message: string,
        readonly reason: OnboardingSearchError,
        readonly retryable: boolean
    ) {
        super(message);
    }
}

export async function fetchOnboardingGames(
    identity: PublicChessIdentity,
    signal?: AbortSignal
): Promise<OnboardingGamesResponse> {
    let response: Response;
    try {
        response = await fetch('/api/onboarding/games', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(identity),
            signal,
        });
    } catch (error) {
        if (signal?.aborted) throw error;
        throw new OnboardingClientError(
            'You appear to be offline. The warm-up puzzle still works.',
            'OFFLINE',
            true
        );
    }
    const payload = (await response.json().catch(() => ({}))) as {
        code?: OnboardingSearchError;
        error?: string;
        retryable?: boolean;
    };
    if (!response.ok) {
        throw new OnboardingClientError(
            payload.error ?? 'Could not load public games.',
            payload.code ?? 'UNKNOWN',
            payload.retryable ?? response.status >= 500
        );
    }
    return payload as OnboardingGamesResponse;
}

function isTrainingPrompt(value: unknown): value is TrainingPromptDto {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prompt = value as Partial<TrainingPromptDto>;
    return (
        typeof prompt.id === 'string' &&
        typeof prompt.solutionRevisionId === 'string' &&
        typeof prompt.fen === 'string' &&
        (prompt.sideToMove === 'w' || prompt.sideToMove === 'b') &&
        !!prompt.grading &&
        prompt.grading.version === 1
    );
}

function safeUrl(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    try {
        const url = new URL(value);
        return url.protocol === 'https:' ? url.toString() : null;
    } catch {
        return null;
    }
}

export async function fetchCurrentMasterPuzzle(): Promise<LandingPuzzleDto> {
    try {
        const response = await fetch('/api/master-puzzle', {
            headers: { Accept: 'application/json' },
        });
        if (!response.ok) return WARMUP_PUZZLE;
        const payload = (await response.json()) as {
            state?: string;
            publication?: {
                id?: string;
                slug?: string;
                headline?: string;
                teaser?: string;
                attributionLabel?: string;
                publishedAt?: string;
                sourceUrl?: string;
                prompt?: unknown;
                context?: {
                    sourceUrl?: string | null;
                    playedAt?: string;
                    players?: {
                        white?: { name?: string };
                        black?: { name?: string };
                    };
                };
            };
            prompt?: unknown;
        };
        const publication = payload.publication;
        const prompt = publication?.prompt ?? payload.prompt;
        if (
            (payload.state !== 'ready' && payload.state !== 'fallback') ||
            !isTrainingPrompt(prompt)
        ) {
            return WARMUP_PUZZLE;
        }
        return {
            id: `master:${publication?.id ?? prompt.id}`,
            prompt,
            context: {
                kind: 'MASTER',
                headline:
                    publication?.headline ??
                    'A strong player missed this. Can you find the move?',
                teaser: publication?.teaser,
                attributionLabel: publication?.attributionLabel,
                sourceUrl: safeUrl(
                    publication?.context?.sourceUrl ?? publication?.sourceUrl
                ),
                playedAt:
                    publication?.context?.playedAt ??
                    publication?.publishedAt ??
                    null,
                whiteName: publication?.context?.players?.white?.name,
                blackName: publication?.context?.players?.black?.name,
            },
        };
    } catch {
        return WARMUP_PUZZLE;
    }
}

export async function recordOnboardingEvent(
    event: OnboardingAnalyticsEvent
): Promise<boolean> {
    try {
        const response = await fetch('/api/onboarding/events', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(event),
            keepalive: true,
        });
        return response.ok;
    } catch {
        return false;
    }
}
