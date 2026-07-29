import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchTrainingSession } from '@/lib/training/client';

describe('training client transport', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('serializes canonical session filters as repeated query parameters', async () => {
        const fetchMock = vi.fn(
            async (input: RequestInfo | URL, init?: RequestInit) => {
                void input;
                void init;
                return (
                new Response(
                    JSON.stringify({
                        items: [],
                        nextCursor: null,
                        appliedFilters: {},
                    }),
                    {
                        status: 200,
                        headers: { 'content-type': 'application/json' },
                    }
                )
                );
            }
        );
        vi.stubGlobal('fetch', fetchMock);

        await fetchTrainingSession({
            limit: 7,
            filters: {
                focus: 'MAJOR',
                phases: ['OPENING', 'ENDGAME'],
                sourceKinds: ['MY_MISTAKE'],
                lessonKinds: ['IMPROVE_POSITION'],
                themes: ['quiet-move', 'development'],
                includeAttempted: true,
            },
        });

        const requested = new URL(
            String(fetchMock.mock.calls[0]?.[0]),
            'http://localhost'
        );
        expect(requested.pathname).toBe('/api/training/session');
        expect(requested.searchParams.get('focus')).toBe('major');
        expect(requested.searchParams.getAll('phase')).toEqual([
            'OPENING',
            'ENDGAME',
        ]);
        expect(requested.searchParams.getAll('theme')).toEqual([
            'quiet-move',
            'development',
        ]);
        expect(requested.searchParams.get('includeAttempted')).toBe('true');
    });
});
