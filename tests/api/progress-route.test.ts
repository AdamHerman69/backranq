import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { readJson } from '../helpers/route';
import {
    mockAuthModule,
    setMockUserId,
} from '../helpers/route-mocks';

const getProgressSnapshotMock = vi.fn();
class ProgressDatasetTooLargeErrorMock extends Error {
    constructor(public readonly dataset: string) {
        super('Dataset too large');
    }
}

async function importRoute() {
    vi.resetModules();
    mockAuthModule();
    vi.doMock('@/lib/progress/readService', () => ({
        getProgressSnapshot: getProgressSnapshotMock,
        ProgressUserNotFoundError: class extends Error {},
        ProgressDatasetTooLargeError:
            ProgressDatasetTooLargeErrorMock,
    }));
    return import('@/app/api/progress/route');
}

describe('GET /api/progress', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setMockUserId('user-1');
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('requires authentication', async () => {
        setMockUserId(null);
        const route = await importRoute();

        const response = await route.GET(
            new Request('http://localhost/api/progress')
        );

        expect(response.status).toBe(401);
        expect(getProgressSnapshotMock).not.toHaveBeenCalled();
    });

    it('rejects invalid query values before reading', async () => {
        const route = await importRoute();

        const response = await route.GET(
            new Request(
                'http://localhost/api/progress?scope=365'
            )
        );

        expect(response.status).toBe(400);
        expect(getProgressSnapshotMock).not.toHaveBeenCalled();
    });

    it('delegates to the direct server reader with no-store caching', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(
            new Date('2026-07-30T12:00:00.000Z')
        );
        getProgressSnapshotMock.mockResolvedValue({
            definitionVersion: 'progress-v1',
        });
        const route = await importRoute();

        const response = await route.GET(
            new Request(
                'http://localhost/api/progress?scope=28&provider=lichess&timeClass=rapid'
            )
        );

        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toBe(
            'private, no-store'
        );
        expect(getProgressSnapshotMock).toHaveBeenCalledWith({
            userId: 'user-1',
            scope: 28,
            asOf: new Date('2026-07-30T12:00:00.000Z'),
            filters: {
                providers: ['LICHESS'],
                timeClasses: ['RAPID'],
            },
        });
        await expect(readJson(response)).resolves.toEqual({
            definitionVersion: 'progress-v1',
        });
    });

    it('fails closed when the retained dataset exceeds a safe read cap', async () => {
        getProgressSnapshotMock.mockRejectedValue(
            new ProgressDatasetTooLargeErrorMock('terminal attempts')
        );
        const route = await importRoute();

        const response = await route.GET(
            new Request('http://localhost/api/progress')
        );

        expect(response.status).toBe(422);
        expect(response.headers.get('cache-control')).toBe(
            'private, no-store'
        );
        await expect(readJson(response)).resolves.toEqual({
            error: 'Progress cannot safely assemble this retained dataset yet',
            code: 'DATASET_TOO_LARGE',
            dataset: 'terminal attempts',
        });
    });
});
