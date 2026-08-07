import type {
    RecordTrainingAttemptRequest,
    RecordTrainingAttemptResponse,
    TrainingApiErrorResponse,
    TrainingMomentResponse,
    PracticeFeedRequest,
    PracticeFeedResponse,
} from '@/lib/training/api';

export class TrainingClientError extends Error {
    readonly status: number;
    readonly code: TrainingApiErrorResponse['code'] | null;

    constructor({
        message,
        status,
        code,
    }: {
        message: string;
        status: number;
        code?: TrainingApiErrorResponse['code'];
    }) {
        super(message);
        this.name = 'TrainingClientError';
        this.status = status;
        this.code = code ?? null;
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

export async function fetchPracticeFeed(
    request: PracticeFeedRequest = {},
    signal?: AbortSignal
): Promise<PracticeFeedResponse> {
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
    if (request.filters?.mode) {
        params.set('mode', request.filters.mode.toLowerCase());
    }

    const query = params.toString();
    const response = await fetch(
        `/api/training/feed${query ? `?${query}` : ''}`,
        {
            cache: 'no-store',
            signal,
        }
    );
    return readJson<PracticeFeedResponse>(response);
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

export async function recordTrainingAttempt(
    momentId: string,
    request: RecordTrainingAttemptRequest,
    signal?: AbortSignal
): Promise<RecordTrainingAttemptResponse> {
    const response = await fetch(
        `/api/training/moments/${encodeURIComponent(momentId)}/attempts`,
        {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(request),
            signal,
        }
    );
    return readJson<RecordTrainingAttemptResponse>(response);
}
