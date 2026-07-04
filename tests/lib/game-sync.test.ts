import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedGame } from '@/lib/types/game';
import {
    getExistingExternalIds,
    saveGamesToLibrary,
} from '@/lib/services/gameSync';

function makeGame(id: string): NormalizedGame {
    return {
        id,
        provider: 'lichess',
        playedAt: '2026-07-04T12:00:00.000Z',
        timeClass: 'blitz',
        rated: true,
        white: { name: 'Ada', rating: 1800 },
        black: { name: 'Grace', rating: 1750 },
        result: '1-0',
        termination: 'Normal',
        pgn: '[Event "Test"]\n\n1. e4 e5 1-0',
    };
}

function jsonResponse(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
        headers: { 'content-type': 'application/json' },
        status,
    });
}

describe('game sync service chunking', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn());
    });

    it('chunks existing-id checks at the server limit', async () => {
        vi.mocked(fetch)
            .mockResolvedValueOnce(jsonResponse({ existingExternalIds: ['id-1'] }))
            .mockResolvedValueOnce(jsonResponse({ existingExternalIds: ['id-200'] }));

        const ids = await getExistingExternalIds({
            provider: 'lichess',
            externalIds: Array.from({ length: 201 }, (_, i) => `id-${i}`),
        });

        expect(ids).toEqual(new Set(['id-1', 'id-200']));
        expect(fetch).toHaveBeenCalledTimes(2);
        const firstBody = JSON.parse(
            vi.mocked(fetch).mock.calls[0]?.[1]?.body as string
        ) as { externalIds: string[] };
        const secondBody = JSON.parse(
            vi.mocked(fetch).mock.calls[1]?.[1]?.body as string
        ) as { externalIds: string[] };
        expect(firstBody.externalIds).toHaveLength(200);
        expect(secondBody.externalIds).toEqual(['id-200']);
    });

    it('preserves partial save success and offsets chunk error indexes', async () => {
        vi.mocked(fetch)
            .mockResolvedValueOnce(
                jsonResponse({
                    saved: 200,
                    skipped: 0,
                    ids: { 'lichess:id-0': 'db-0' },
                    errors: [],
                })
            )
            .mockResolvedValueOnce(
                jsonResponse(
                    {
                        error: 'No games saved',
                        saved: 0,
                        skipped: 1,
                        ids: {},
                        errors: [
                            {
                                index: 0,
                                id: 'lichess:id-200',
                                kind: 'validation',
                                error: 'Invalid pgn',
                            },
                        ],
                    },
                    400
                )
            );

        const result = await saveGamesToLibrary({
            games: Array.from({ length: 201 }, (_, i) =>
                makeGame(`lichess:id-${i}`)
            ),
        });

        expect(result).toMatchObject({
            saved: 200,
            skipped: 1,
            ids: { 'lichess:id-0': 'db-0' },
            errors: [
                {
                    index: 200,
                    id: 'lichess:id-200',
                    kind: 'validation',
                    error: 'Invalid pgn',
                },
            ],
        });
    });
});
