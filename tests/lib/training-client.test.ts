import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    fetchPracticeFeed,
    fetchTrainingMoment,
} from '@/lib/training/client';

describe('training client transport', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('serializes canonical practice filters as repeated query parameters', async () => {
        const fetchMock = vi.fn(
            async (input: RequestInfo | URL, init?: RequestInit) => {
                void input;
                void init;
                return (
                new Response(
                    JSON.stringify({
                        ownerId: 'user-1',
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

        await fetchPracticeFeed('user-1', {
            limit: 7,
            filters: {
                focus: 'MAJOR',
                phases: ['OPENING', 'ENDGAME'],
                sourceKinds: ['MY_MISTAKE'],
                lessonKinds: ['IMPROVE_POSITION'],
                themes: ['quiet-move', 'development'],
                mode: 'REVIEW',
            },
        });

        const requested = new URL(
            String(fetchMock.mock.calls[0]?.[0]),
            'http://localhost'
        );
        expect(requested.pathname).toBe('/api/training/feed');
        expect(requested.searchParams.get('focus')).toBe('major');
        expect(requested.searchParams.getAll('phase')).toEqual([
            'OPENING',
            'ENDGAME',
        ]);
        expect(requested.searchParams.getAll('theme')).toEqual([
            'quiet-move',
            'development',
        ]);
        expect(requested.searchParams.get('mode')).toBe('review');
    });

    it('rejects a successful practice response for a different owner', async () => {
        let release!: () => void;
        const deferred = new Promise<void>((resolve) => {
            release = resolve;
        });
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => {
                await deferred;
                return new Response(
                    JSON.stringify({
                        ownerId: 'user-a',
                        items: [],
                        nextCursor: null,
                        appliedFilters: {},
                    }),
                    {
                        status: 200,
                        headers: { 'content-type': 'application/json' },
                    }
                );
            })
        );

        const request = fetchPracticeFeed('user-b');
        release();
        await expect(request).rejects.toMatchObject({
            status: 409,
            code: 'OWNER_MISMATCH',
        });
    });

    it('rejects a training moment detail for a different owner', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () =>
                new Response(
                    JSON.stringify({
                        ownerId: 'user-a',
                        moment: {
                            id: 'moment-a',
                            solutionRevisionId: 'revision-a',
                            fen: '8/8/8/8/8/8/4K3/6k1 w - - 0 1',
                            sideToMove: 'w',
                            grading: {},
                        },
                    }),
                    {
                        status: 200,
                        headers: { 'content-type': 'application/json' },
                    }
                )
            )
        );

        await expect(
            fetchTrainingMoment('user-b', 'moment-a')
        ).rejects.toMatchObject({
            status: 409,
            code: 'OWNER_MISMATCH',
        });
    });
});
