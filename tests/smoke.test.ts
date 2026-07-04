import { describe, expect, it } from 'vitest';
import { createJsonRequest, readJson } from './helpers/route';
import { authMock, prismaMock, setMockUserId } from './helpers/route-mocks';

describe('test foundation', () => {
    it('supports JSON request and response helpers', async () => {
        const request = createJsonRequest('http://localhost/api/example', {
            ok: true,
        });
        const response = Response.json({ ready: true });

        await expect(request.json()).resolves.toEqual({ ok: true });
        await expect(readJson(response)).resolves.toEqual({ ready: true });
        expect(request.headers.get('content-type')).toBe('application/json');
    });

    it('provides auth and Prisma mocks for route tests', async () => {
        setMockUserId('user_123');
        prismaMock.analyzedGame.findMany.mockResolvedValue([]);

        await expect(authMock()).resolves.toEqual({
            user: { id: 'user_123' },
        });
        await expect(prismaMock.analyzedGame.findMany()).resolves.toEqual([]);
    });
});
