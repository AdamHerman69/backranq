import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readJson } from '../helpers/route';
import { EXPECTED_OWNER_HEADER } from '@/lib/auth/ownerContract';
import {
    mockAuthModule,
    setMockUserId,
} from '../helpers/route-mocks';

type SyncRouteModule = typeof import('@/app/api/sync/route');

const dispatchUserSyncJobsMock = vi.fn();
const getUserSyncActivityMock = vi.fn();

async function importRoute(): Promise<SyncRouteModule> {
    vi.resetModules();
    mockAuthModule();
    vi.doMock('@/lib/services/syncJobs', () => ({
        dispatchUserSyncJobs: dispatchUserSyncJobsMock,
        getUserSyncActivity: getUserSyncActivityMock,
    }));
    return import('@/app/api/sync/route');
}

function post(body: unknown, ownerId: string | null = 'user-1') {
    const headers = new Headers({ 'Content-Type': 'application/json' });
    if (ownerId !== null) headers.set(EXPECTED_OWNER_HEADER, ownerId);
    return new Request('http://localhost/api/sync', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
    });
}

describe('/api/sync', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        getUserSyncActivityMock.mockResolvedValue({ providers: [] });
        dispatchUserSyncJobsMock.mockResolvedValue({
            providers: [],
            published: [],
        });
    });

    it('requires authentication before reading or starting sync', async () => {
        const route = await importRoute();
        setMockUserId(null);

        const getResponse = await route.GET();
        const postResponse = await route.POST(post({}));

        expect(getResponse.status).toBe(401);
        expect(postResponse.status).toBe(401);
        expect(dispatchUserSyncJobsMock).not.toHaveBeenCalled();
    });

    it('validates selected providers and the bounded stale threshold', async () => {
        const route = await importRoute();
        setMockUserId('user-1');

        const providerResponse = await route.POST(
            post({ providers: ['unknown'] })
        );
        const staleResponse = await route.POST(
            post({ onlyIfStaleMinutes: 20_000 })
        );

        expect(providerResponse.status).toBe(400);
        expect(staleResponse.status).toBe(400);
        expect(dispatchUserSyncJobsMock).not.toHaveBeenCalled();
    });

    it.each([null, 'user-a'])(
        'rejects missing or stale owner %s before parsing or dispatch',
        async (ownerId) => {
            const route = await importRoute();
            setMockUserId('user-1');

            const response = await route.POST(
                new Request('http://localhost/api/sync', {
                    method: 'POST',
                    headers:
                        ownerId === null
                            ? undefined
                            : { [EXPECTED_OWNER_HEADER]: ownerId },
                    body: 'not-json',
                })
            );

            expect(response.status).toBe(409);
            await expect(readJson(response)).resolves.toMatchObject({
                code: 'OWNER_MISMATCH',
            });
            expect(dispatchUserSyncJobsMock).not.toHaveBeenCalled();
        }
    );

    it('reads a bounded owner-scoped set of requested completion jobs', async () => {
        getUserSyncActivityMock.mockResolvedValue({
            providers: [],
            requestedJobs: [{ id: 'job-old', status: 'SUCCEEDED' }],
        });
        const route = await importRoute();
        setMockUserId('user-1');

        const response = await route.GET(
            new Request(
                'http://localhost/api/sync?jobIds=job-old,job-running'
            )
        );

        expect(response.status).toBe(200);
        expect(getUserSyncActivityMock).toHaveBeenCalledWith('user-1', {
            requestedJobIds: ['job-old', 'job-running'],
        });
        await expect(readJson(response)).resolves.toMatchObject({
            ownerId: 'user-1',
            requestedJobs: [{ id: 'job-old', status: 'SUCCEEDED' }],
        });
    });

    it('rejects malformed or excessive completion job IDs', async () => {
        const route = await importRoute();
        setMockUserId('user-1');

        const malformed = await route.GET(
            new Request('http://localhost/api/sync?jobIds=job-1,%20bad')
        );
        const excessive = await route.GET(
            new Request(
                'http://localhost/api/sync?jobIds=job-1,job-2,job-3,job-4,job-5'
            )
        );

        expect(malformed.status).toBe(400);
        expect(excessive.status).toBe(400);
        expect(getUserSyncActivityMock).not.toHaveBeenCalled();
    });

    it('rejects malformed JSON instead of treating it as sync-all', async () => {
        const route = await importRoute();
        setMockUserId('user-1');

        const response = await route.POST(
            new Request('http://localhost/api/sync', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    [EXPECTED_OWNER_HEADER]: 'user-1',
                },
                body: '{',
            })
        );

        expect(response.status).toBe(400);
        await expect(readJson(response)).resolves.toEqual({
            error: 'Invalid request body',
        });
        expect(dispatchUserSyncJobsMock).not.toHaveBeenCalled();
    });

    it('returns joined and freshly queued provider jobs with activity', async () => {
        dispatchUserSyncJobsMock.mockResolvedValue({
            providers: [
                {
                    userId: 'user-1',
                    provider: 'LICHESS',
                    queued: false,
                    jobId: 'active-job',
                    skippedReason: 'already-queued',
                },
                {
                    userId: 'user-1',
                    provider: 'CHESSCOM',
                    queued: true,
                    jobId: 'new-job',
                    skippedReason: null,
                },
            ],
            published: [
                {
                    jobId: 'new-job',
                    queued: true,
                    messageId: 'message-1',
                    jobStatus: 'QUEUED',
                },
            ],
        });
        getUserSyncActivityMock.mockResolvedValue({
            providers: [{ provider: 'LICHESS', activeJob: { id: 'active-job' } }],
        });
        const route = await importRoute();
        setMockUserId('user-1');

        const response = await route.POST(
            post({
                providers: ['lichess', 'chesscom'],
                onlyIfStaleMinutes: 60,
            })
        );

        expect(response.status).toBe(200);
        await expect(readJson(response)).resolves.toMatchObject({
            ownerId: 'user-1',
            requested: ['lichess', 'chesscom'],
            providers: [
                {
                    provider: 'lichess',
                    queued: false,
                    jobId: 'active-job',
                    skippedReason: 'already-queued',
                    queuePublished: null,
                    jobStatus: null,
                },
                {
                    provider: 'chesscom',
                    queued: true,
                    jobId: 'new-job',
                    skippedReason: null,
                    queuePublished: true,
                    jobStatus: 'QUEUED',
                },
            ],
            active: {
                ownerId: 'user-1',
                providers: [{ provider: 'LICHESS' }],
            },
        });
        expect(dispatchUserSyncJobsMock).toHaveBeenCalledWith({
            userId: 'user-1',
            providers: ['LICHESS', 'CHESSCOM'],
            onlyIfStaleMinutes: 60,
        });
    });
});
