import { beforeEach, describe, expect, it, vi } from 'vitest';

import { readJson } from '../helpers/route';
import { mockAuthModule, setMockUserId } from '../helpers/route-mocks';

const getPracticeInventorySummaryMock = vi.fn();

async function importRoute() {
    vi.resetModules();
    mockAuthModule();
    vi.doMock('@/lib/training/practiceDue', () => ({
        getPracticeInventorySummary: getPracticeInventorySummaryMock,
    }));
    return import('@/app/api/training/due/route');
}

describe('GET /api/training/due', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setMockUserId('user-1');
    });

    it('returns current inventory and due counts without caching', async () => {
        getPracticeInventorySummaryMock.mockResolvedValue({
            userId: 'user-1',
            totalEligibleCount: 8,
            dueCount: 5,
            earliestDueAt: new Date('2026-08-01T09:00:00.000Z'),
        });
        const route = await importRoute();

        const response = await route.GET();

        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toBe(
            'private, no-store'
        );
        await expect(readJson(response)).resolves.toEqual({
            totalEligibleCount: 8,
            dueCount: 5,
            earliestDueAt: '2026-08-01T09:00:00.000Z',
        });
        expect(getPracticeInventorySummaryMock).toHaveBeenCalledWith(
            'user-1'
        );
    });

    it('keeps caught-up inventory distinct from no candidates', async () => {
        getPracticeInventorySummaryMock.mockResolvedValue({
            userId: 'user-1',
            totalEligibleCount: 6,
            dueCount: 0,
            earliestDueAt: null,
        });
        const route = await importRoute();

        await expect(readJson(await route.GET())).resolves.toEqual({
            totalEligibleCount: 6,
            dueCount: 0,
            earliestDueAt: null,
        });
    });

    it('requires authentication', async () => {
        setMockUserId(null);
        const route = await importRoute();

        expect((await route.GET()).status).toBe(401);
        expect(getPracticeInventorySummaryMock).not.toHaveBeenCalled();
    });
});
