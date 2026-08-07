import { Chess } from 'chess.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const publishLibraryChanged = vi.fn();
const setOwner = vi.fn();
const enqueueGameDbIds = vi.fn();

async function importClient() {
    vi.resetModules();
    vi.doMock('@/lib/analysis/analysisCompletion', () => ({
        publishLibraryChanged,
    }));
    vi.doMock('@/lib/analysis/backgroundAnalysisManager', () => ({
        backgroundAnalysis: { setOwner, enqueueGameDbIds },
    }));
    return import('@/lib/coach/completedGame');
}

function completedGame() {
    const game = new Chess();
    game.move('f3');
    game.move('e5');
    game.move('g4');
    game.move('Qh4#');
    return game;
}

describe('completed Coach game client handoff', () => {
    beforeEach(() => vi.clearAllMocks());

    it('builds immutable PGN provenance without mutating the live game', async () => {
        const client = await importClient();
        const game = completedGame();
        expect(game.getHeaders().White).toBe('?');
        const payload = client.buildCompletedCoachGamePayload({
            game,
            sessionId: 'session-1',
            userSide: 'w',
            completedAt: '2026-08-04T12:00:00.000Z',
        });

        expect(payload).toMatchObject({
            sessionId: 'session-1',
            userSide: 'white',
            completedAt: '2026-08-04T12:00:00.000Z',
        });
        expect(payload.pgn).toContain('[White "Backranq Player"]');
        expect(payload.pgn).toContain('[Result "0-1"]');
        expect(game.getHeaders().White).toBe('?');
    });

    it('starts honest browser analysis only when the server requests it', async () => {
        const client = await importClient();
        vi.stubGlobal(
            'fetch',
            vi.fn(async () =>
                Response.json({
                    ownerId: 'user-1',
                    gameId: 'db-game-1',
                    created: true,
                    needsAnalysis: true,
                })
            )
        );

        await client.saveCompletedCoachGameAndAnalyze({
            ownerId: 'user-1',
            game: completedGame(),
            sessionId: 'session-1',
            userSide: 'w',
            completedAt: '2026-08-04T12:00:00.000Z',
        });

        expect(publishLibraryChanged).toHaveBeenCalled();
        expect(setOwner).toHaveBeenCalledWith('user-1');
        expect(enqueueGameDbIds).toHaveBeenCalledWith('user-1', [
            'db-game-1',
        ]);
    });

    it('refuses a response for a different owner before touching queues', async () => {
        const client = await importClient();
        vi.stubGlobal(
            'fetch',
            vi.fn(async () =>
                Response.json({
                    ownerId: 'user-2',
                    gameId: 'db-game-2',
                    created: true,
                    needsAnalysis: true,
                })
            )
        );

        await expect(
            client.saveCompletedCoachGameAndAnalyze({
                ownerId: 'user-1',
                game: completedGame(),
                sessionId: 'session-1',
                userSide: 'w',
                completedAt: '2026-08-04T12:00:00.000Z',
            })
        ).rejects.toThrow(/owner did not match/i);
        expect(enqueueGameDbIds).not.toHaveBeenCalled();
    });
});
