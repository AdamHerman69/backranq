import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readJson } from '../helpers/route';

const getPublicMasterSlotMock = vi.fn();

async function importRoute() {
    vi.resetModules();
    vi.doMock('@/lib/master/publication', () => ({
        getPublicMasterSlot: getPublicMasterSlotMock,
    }));
    return import('@/app/api/master-puzzle/route');
}

describe('GET /api/master-puzzle', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        getPublicMasterSlotMock.mockResolvedValue({
            state: 'ready',
            slot: { key: 'landing-weekly-master', version: 4 },
            publication: {
                id: 'publication-1',
                slug: 'master-one',
                health: 'FRESH',
                prompt: { id: 'candidate-1' },
            },
        });
    });

    it('serves the public prompt with shared-cache and ETag headers', async () => {
        const route = await importRoute();
        const response = await route.GET(
            new Request('http://localhost/api/master-puzzle')
        );
        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toContain('s-maxage=60');
        expect(response.headers.get('etag')).toBe(
            '"master-4-ready-publication-1-FRESH"'
        );
        await expect(readJson(response)).resolves.toMatchObject({
            state: 'ready',
            publication: { id: 'publication-1' },
        });
    });

    it('returns 304 when the slot version and publication are unchanged', async () => {
        const route = await importRoute();
        const response = await route.GET(
            new Request('http://localhost/api/master-puzzle', {
                headers: {
                    'if-none-match':
                        '"master-4-ready-publication-1-FRESH"',
                },
            })
        );
        expect(response.status).toBe(304);
    });
});
