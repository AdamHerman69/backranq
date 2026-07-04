import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readJson } from '../helpers/route';
import {
    mockAuthModule,
    mockPrismaModule,
    prismaMock,
    setMockUserId,
} from '../helpers/route-mocks';

type PuzzleRouteModule = typeof import('@/app/api/puzzles/[id]/route');

async function importRoute(): Promise<PuzzleRouteModule> {
    vi.resetModules();
    mockAuthModule();
    mockPrismaModule();

    return import('@/app/api/puzzles/[id]/route');
}

function createDeleteRequest() {
    return new Request('http://localhost/api/puzzles/puzzle-1', {
        method: 'DELETE',
    });
}

function routeParams() {
    return { params: Promise.resolve({ id: 'puzzle-1' }) };
}

describe('DELETE /api/puzzles/[id]', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setMockUserId('user-1');
    });

    it('returns not found for missing or archived puzzles before writing', async () => {
        const route = await importRoute();
        prismaMock.puzzle.findFirst.mockResolvedValue(null);

        const response = await route.DELETE(createDeleteRequest(), routeParams());

        await expect(readJson(response)).resolves.toEqual({
            error: 'Not found',
        });
        expect(response.status).toBe(404);
        expect(prismaMock.puzzle.findFirst).toHaveBeenCalledWith({
            where: { id: 'puzzle-1', userId: 'user-1', archivedAt: null },
            select: { id: true },
        });
        expect(prismaMock.puzzle.update).not.toHaveBeenCalled();
        expect(prismaMock.puzzle.delete).not.toHaveBeenCalled();
    });

    it('soft-archives puzzles instead of deleting attempt history', async () => {
        const route = await importRoute();
        prismaMock.puzzle.findFirst.mockResolvedValue({ id: 'puzzle-1' });
        prismaMock.puzzle.update.mockResolvedValue({ id: 'puzzle-1' });

        const response = await route.DELETE(createDeleteRequest(), routeParams());

        await expect(readJson(response)).resolves.toEqual({ ok: true });
        expect(response.status).toBe(200);
        expect(prismaMock.puzzle.update).toHaveBeenCalledWith({
            where: { id: 'puzzle-1' },
            data: { archivedAt: expect.any(Date) },
        });
        expect(prismaMock.puzzle.delete).not.toHaveBeenCalled();
    });
});
