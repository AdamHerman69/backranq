import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createJsonRequest, readJson } from '../helpers/route';
import { mockAuthModule, setMockUserId } from '../helpers/route-mocks';

const createAnalysisBatchMock = vi.fn();
const getOwnedByRequestIdMock = vi.fn();
const getOwnedBatchMock = vi.fn();
const summaryMock = vi.fn();
const afterMock = vi.fn();
const flushAnalysisOutboxMock = vi.fn();

const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const BATCH_ID = '22222222-2222-4222-8222-222222222222';
const GAME_ID = '33333333-3333-4333-8333-333333333333';

function batch(overrides: Record<string, unknown> = {}) {
    return {
        id: BATCH_ID,
        userId: 'user-1',
        requestId: REQUEST_ID,
        status: 'PENDING',
        force: false,
        analysisQuality: 'THOROUGH',
        creditCost: 10,
        configHash: 'config-hash',
        completedAt: null,
        lastError: null,
        createdAt: new Date('2026-08-12T00:00:00Z'),
        updatedAt: new Date('2026-08-12T00:00:00Z'),
        ...overrides,
    };
}

function summary() {
    return {
        id: BATCH_ID,
        requestId: REQUEST_ID,
        status: 'PENDING',
        force: false,
        analysisQuality: 'THOROUGH',
        creditCost: 10,
        configHash: 'config-hash',
        counts: {
            total: 1,
            pending: 1,
            queued: 0,
            attached: 0,
            skipped: 0,
            failed: 0,
            cancelled: 0,
            running: 0,
            succeeded: 0,
            jobFailed: 0,
            jobCancelled: 0,
        },
        completedAt: null,
        lastError: null,
        createdAt: new Date('2026-08-12T00:00:00Z'),
        updatedAt: new Date('2026-08-12T00:00:00Z'),
    };
}

async function importCollectionRoute() {
    vi.resetModules();
    mockAuthModule();
    vi.doMock('next/server', async () => {
        const actual = await vi.importActual<typeof import('next/server')>(
            'next/server'
        );
        return { ...actual, after: afterMock };
    });
    vi.doMock('@/lib/services/analysisOutbox', () => ({
        flushAnalysisOutbox: flushAnalysisOutboxMock,
    }));
    vi.doMock('@/lib/services/analysisBatches', () => ({
        AnalysisBatchRequestConflictError: class extends Error {},
        AnalysisBatchGamesUnavailableError: class extends Error {},
        createAnalysisBatch: createAnalysisBatchMock,
        getOwnedAnalysisBatchByRequestId: getOwnedByRequestIdMock,
        analysisBatchSummary: summaryMock,
    }));
    return import('@/app/api/analysis/batches/route');
}

async function importItemRoute() {
    vi.resetModules();
    mockAuthModule();
    vi.doMock('@/lib/services/analysisBatches', () => ({
        getOwnedAnalysisBatch: getOwnedBatchMock,
    }));
    return import('@/app/api/analysis/batches/[id]/route');
}

function post(body: unknown) {
    return createJsonRequest('http://localhost/api/analysis/batches', body, {
        method: 'POST',
    });
}

describe('POST /api/analysis/batches', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setMockUserId('user-1');
        createAnalysisBatchMock.mockResolvedValue({
            batch: batch(),
            created: true,
        });
        summaryMock.mockResolvedValue(summary());
    });

    it('requires authentication before durable acceptance', async () => {
        setMockUserId(null);
        const route = await importCollectionRoute();
        const response = await route.POST(
            post({ requestId: REQUEST_ID, gameIds: [GAME_ID] })
        );

        expect(response.status).toBe(401);
        expect(createAnalysisBatchMock).not.toHaveBeenCalled();
    });

    it('rejects more than 2000 games before creating a batch', async () => {
        const route = await importCollectionRoute();
        const gameIds = Array.from(
            { length: 2001 },
            (_, index) =>
                `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`
        );
        const response = await route.POST(post({ requestId: REQUEST_ID, gameIds }));

        expect(response.status).toBe(413);
        expect(createAnalysisBatchMock).not.toHaveBeenCalled();
    });

    it('returns fast durable 202 acceptance without publishing externally', async () => {
        const route = await importCollectionRoute();
        const response = await route.POST(
            post({ requestId: REQUEST_ID, gameIds: [GAME_ID] })
        );

        expect(response.status).toBe(202);
        expect(response.headers.get('location')).toBe(
            `/api/analysis/batches/${BATCH_ID}`
        );
        await expect(readJson(response)).resolves.toMatchObject({
            batch: { id: BATCH_ID, status: 'PENDING' },
            idempotentReplay: false,
        });
        expect(createAnalysisBatchMock).toHaveBeenCalledWith({
            userId: 'user-1',
            requestId: REQUEST_ID,
            gameIds: [GAME_ID],
            force: false,
            analysisDefaults: undefined,
        });
        expect(afterMock).toHaveBeenCalledOnce();
        expect(flushAnalysisOutboxMock).not.toHaveBeenCalled();
    });

    it('returns the same accepted batch for an idempotent replay', async () => {
        createAnalysisBatchMock.mockResolvedValue({
            batch: batch(),
            created: false,
        });
        const route = await importCollectionRoute();
        const response = await route.POST(
            post({ requestId: REQUEST_ID, gameIds: [GAME_ID] })
        );

        expect(response.status).toBe(202);
        await expect(readJson(response)).resolves.toMatchObject({
            batch: { id: BATCH_ID },
            idempotentReplay: true,
        });
    });

    it('returns 409 when a requestId is reused with a different payload', async () => {
        const route = await importCollectionRoute();
        const batchService = await import('@/lib/services/analysisBatches');
        createAnalysisBatchMock.mockRejectedValue(
            new batchService.AnalysisBatchRequestConflictError()
        );
        const response = await route.POST(
            post({ requestId: REQUEST_ID, gameIds: [GAME_ID], force: true })
        );

        expect(response.status).toBe(409);
        await expect(readJson(response)).resolves.toMatchObject({
            code: 'REQUEST_ID_CONFLICT',
        });
    });
});

describe('owner-scoped analysis batch reads', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setMockUserId('user-1');
        summaryMock.mockResolvedValue(summary());
    });

    it('scopes requestId lookup to the authenticated owner', async () => {
        getOwnedByRequestIdMock.mockResolvedValue(batch());
        const route = await importCollectionRoute();
        const response = await route.GET(
            new Request(
                `http://localhost/api/analysis/batches?requestId=${REQUEST_ID}`
            )
        );

        expect(response.status).toBe(200);
        expect(getOwnedByRequestIdMock).toHaveBeenCalledWith(
            'user-1',
            REQUEST_ID
        );
    });

    it('does not expose another owner batch by id', async () => {
        getOwnedBatchMock.mockResolvedValue(null);
        const route = await importItemRoute();
        const response = await route.GET(
            new Request(`http://localhost/api/analysis/batches/${BATCH_ID}`),
            { params: Promise.resolve({ id: BATCH_ID }) }
        );

        expect(response.status).toBe(404);
        expect(getOwnedBatchMock).toHaveBeenCalledWith('user-1', BATCH_ID, {
            cursor: undefined,
            limit: 100,
        });
    });
});
