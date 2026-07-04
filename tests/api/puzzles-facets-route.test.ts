import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readJson } from '../helpers/route';
import { mockAuthModule, setMockUserId } from '../helpers/route-mocks';

type FacetsRouteModule = typeof import('@/app/api/puzzles/facets/route');

const queryRawMock = vi.fn();

async function importRoute(): Promise<FacetsRouteModule> {
    vi.resetModules();
    mockAuthModule();
    vi.doMock('@/lib/prisma', () => ({
        prisma: { $queryRaw: queryRawMock },
    }));

    return import('@/app/api/puzzles/facets/route');
}

function createGetRequest() {
    return new Request('http://localhost/api/puzzles/facets?limit=10');
}

function sqlText(value: unknown): string {
    if (!value || typeof value !== 'object') return String(value);
    const record = value as Record<string, unknown>;
    if (typeof record.sql === 'string') return record.sql;
    if (typeof record.text === 'string') return record.text;
    if (
        Array.isArray(record.strings) &&
        record.strings.every((item) => typeof item === 'string')
    ) {
        return record.strings.join('?');
    }
    return String(value);
}

describe('GET /api/puzzles/facets', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setMockUserId('00000000-0000-0000-0000-000000000001');
        queryRawMock
            .mockResolvedValueOnce([
                {
                    openingEco: 'B01',
                    openingName: 'Scandinavian Defense',
                    openingVariation: null,
                    count: BigInt(2),
                },
            ])
            .mockResolvedValueOnce([{ tag: 'opening', count: BigInt(3) }]);
    });

    it('filters archived puzzles out of opening and tag facets', async () => {
        const route = await importRoute();

        const response = await route.GET(createGetRequest());

        await expect(readJson(response)).resolves.toEqual({
            openings: [
                {
                    value: 'B01',
                    label: 'B01 Scandinavian Defense',
                    count: 2,
                },
            ],
            tags: [{ value: 'opening', label: 'opening', count: 3 }],
        });
        expect(response.status).toBe(200);
        expect(queryRawMock).toHaveBeenCalledTimes(2);

        const openingSql = sqlText(queryRawMock.mock.calls[0]?.[0]);
        const tagSql = sqlText(queryRawMock.mock.calls[1]?.[0]);
        expect(openingSql).toContain('"archivedAt" IS NULL');
        expect(tagSql).toContain('p."archivedAt" IS NULL');
    });
});
