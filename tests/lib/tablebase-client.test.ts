import { describe, expect, it, vi } from 'vitest';
import {
    LichessTablebaseClient,
    conservativeTablebaseWdl,
} from '@/lib/analysis/tablebase';

const sevenPieceFen = '8/8/8/8/8/2k5/4K3/6R1 w - - 0 1';

function jsonResponse(value: unknown): Response {
    return new Response(JSON.stringify(value), {
        status: 200,
        headers: { 'content-type': 'application/json' },
    });
}

describe('Lichess Syzygy evidence client', () => {
    it('maps ambiguous 50-move categories conservatively', () => {
        expect(conservativeTablebaseWdl('win')).toBe('WIN');
        expect(conservativeTablebaseWdl('syzygy-loss')).toBe('LOSS');
        expect(conservativeTablebaseWdl('cursed-win')).toBe('DRAW');
        expect(conservativeTablebaseWdl('blessed-loss')).toBe('DRAW');
        expect(conservativeTablebaseWdl('maybe-win')).toBe('UNKNOWN');
    });

    it('keeps WDL/DTZ explicit and inverts move outcomes to the mover POV', async () => {
        const fetchImpl = vi.fn(async () =>
            jsonResponse({
                category: 'win',
                dtz: 7,
                precise_dtz: 7,
                checkmate: false,
                stalemate: false,
                insufficient_material: false,
                moves: [
                    {
                        uci: 'g1g3',
                        san: 'Rg3',
                        // Resulting position is a loss for the opponent.
                        category: 'loss',
                        dtz: -6,
                        precise_dtz: -6,
                    },
                    {
                        uci: 'g1g2',
                        category: 'maybe-loss',
                    },
                ],
            })
        );
        const client = new LichessTablebaseClient({
            fetchImpl,
            minRequestIntervalMs: 0,
            now: () => Date.parse('2026-01-01T00:00:00.000Z'),
        });

        const evidence = await client.probe(sevenPieceFen);

        expect(evidence).toMatchObject({
            source: 'LICHESS_SYZYGY',
            wdl: 'WIN',
            dtz: 7,
            preciseDtz: 7,
            moves: [
                {
                    uci: 'g1g3',
                    wdl: 'WIN',
                    categoryAfterMove: 'loss',
                    dtz: -6,
                },
                {
                    uci: 'g1g2',
                    wdl: 'UNKNOWN',
                },
            ],
        });
        expect(evidence).not.toHaveProperty('cp');
    });

    it('does not call the endpoint above seven pieces and deduplicates cached probes', async () => {
        const fetchImpl = vi.fn(async () =>
            jsonResponse({
                category: 'draw',
                moves: [],
            })
        );
        const client = new LichessTablebaseClient({
            fetchImpl,
            minRequestIntervalMs: 0,
        });

        await expect(client.probe(new (await import('chess.js')).Chess().fen()))
            .resolves.toBeNull();
        const [first, second] = await Promise.all([
            client.probe(sevenPieceFen),
            client.probe(sevenPieceFen),
        ]);
        const third = await client.probe(sevenPieceFen);

        expect(first?.wdl).toBe('DRAW');
        expect(second).toEqual(first);
        expect(third).toEqual(first);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('serializes distinct requests behind the configured rate gate', async () => {
        let now = 1_000;
        const sleeps: number[] = [];
        const fetchImpl = vi.fn(async () =>
            jsonResponse({ category: 'draw', moves: [] })
        );
        const client = new LichessTablebaseClient({
            fetchImpl,
            minRequestIntervalMs: 600,
            now: () => now,
            sleep: async (ms) => {
                sleeps.push(ms);
                now += ms;
            },
        });

        await Promise.all([
            client.probe(sevenPieceFen),
            client.probe('8/8/8/8/8/2k5/4K3/7R w - - 0 1'),
        ]);

        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(sleeps).toEqual([600]);
    });

    it('turns a watchdog timeout into absent evidence, never a guessed result', async () => {
        const fetchImpl = vi.fn(
            (_input: string | URL | Request, init?: RequestInit) =>
                new Promise<Response>((_resolve, reject) => {
                    init?.signal?.addEventListener('abort', () => {
                        const error = new Error('aborted');
                        error.name = 'AbortError';
                        reject(error);
                    });
                })
        );
        const client = new LichessTablebaseClient({
            fetchImpl,
            minRequestIntervalMs: 0,
            timeoutMs: 100,
        });

        await expect(client.probe(sevenPieceFen)).resolves.toBeNull();
    });
});
