import type {
    RevealTrainingMomentRequest,
    RevealTrainingMomentResponse,
    SubmitTrainingAttemptRequest,
    SubmitTrainingAttemptResponse,
    TrainingApiErrorResponse,
    TrainingMomentResponse,
    TrainingSessionRequest,
    TrainingSessionResponse,
} from '@/lib/training/api';

export class TrainingClientError extends Error {
    readonly status: number;
    readonly code: TrainingApiErrorResponse['code'] | null;
    readonly retryAfterMs: number | null;

    constructor({
        message,
        status,
        code,
        retryAfterMs,
    }: {
        message: string;
        status: number;
        code?: TrainingApiErrorResponse['code'];
        retryAfterMs?: number;
    }) {
        super(message);
        this.name = 'TrainingClientError';
        this.status = status;
        this.code = code ?? null;
        this.retryAfterMs =
            typeof retryAfterMs === 'number' ? retryAfterMs : null;
    }
}

async function readJson<T>(response: Response): Promise<T> {
    const body = (await response.json().catch(() => null)) as
        | T
        | TrainingApiErrorResponse
        | null;

    if (!response.ok) {
        const apiError = body as TrainingApiErrorResponse | null;
        throw new TrainingClientError({
            message:
                apiError?.error ??
                `Training request failed (${response.status}).`,
            status: response.status,
            code: apiError?.code,
            retryAfterMs: apiError?.retryAfterMs,
        });
    }

    if (body == null) {
        throw new TrainingClientError({
            message: 'Training service returned an empty response.',
            status: response.status,
        });
    }
    return body as T;
}

function appendMany(
    params: URLSearchParams,
    key: string,
    values: readonly string[] | undefined
) {
    for (const value of values ?? []) params.append(key, value);
}

export async function fetchTrainingSession(
    request: TrainingSessionRequest = {},
    signal?: AbortSignal
): Promise<TrainingSessionResponse> {
    const params = new URLSearchParams();
    if (typeof request.limit === 'number') {
        params.set('limit', String(request.limit));
    }
    if (request.cursor) params.set('cursor', request.cursor);

    if (request.filters?.focus) {
        params.set(
            'focus',
            request.filters.focus.toLowerCase()
        );
    }
    appendMany(params, 'phase', request.filters?.phases);
    appendMany(params, 'sourceKind', request.filters?.sourceKinds);
    appendMany(params, 'lessonKind', request.filters?.lessonKinds);
    appendMany(params, 'theme', request.filters?.themes);
    if (typeof request.filters?.minConfidence === 'number') {
        params.set('minConfidence', String(request.filters.minConfidence));
    }
    if (typeof request.filters?.includeAttempted === 'boolean') {
        params.set(
            'includeAttempted',
            String(request.filters.includeAttempted)
        );
    }

    const query = params.toString();
    const response = await fetch(
        `/api/training/session${query ? `?${query}` : ''}`,
        {
            cache: 'no-store',
            signal,
        }
    );
    return readJson<TrainingSessionResponse>(response);
}

export async function fetchTrainingMoment(
    momentId: string,
    signal?: AbortSignal
): Promise<TrainingMomentResponse> {
    const response = await fetch(
        `/api/training/moments/${encodeURIComponent(momentId)}`,
        {
            cache: 'no-store',
            signal,
        }
    );
    return readJson<TrainingMomentResponse>(response);
}

export async function submitTrainingAttempt(
    momentId: string,
    request: SubmitTrainingAttemptRequest,
    signal?: AbortSignal
): Promise<SubmitTrainingAttemptResponse> {
    const response = await fetch(
        `/api/training/moments/${encodeURIComponent(momentId)}/attempts`,
        {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(request),
            signal,
        }
    );
    return readJson<SubmitTrainingAttemptResponse>(response);
}

export async function revealTrainingMoment(
    momentId: string,
    request: RevealTrainingMomentRequest,
    signal?: AbortSignal
): Promise<RevealTrainingMomentResponse> {
    const response = await fetch(
        `/api/training/moments/${encodeURIComponent(momentId)}/reveal`,
        {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(request),
            signal,
        }
    );
    return readJson<RevealTrainingMomentResponse>(response);
}
