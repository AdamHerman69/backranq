// Regressions for setup parsing, black-start identity, and v3 browser persistence.
import { Chess } from 'chess.js';
import { describe, expect, it, vi } from 'vitest';
import { extractTrainingMomentsFromGames } from '@/lib/analysis/extractTrainingMoments';
import { analysisDefaultsToExtractOptions } from '@/lib/preferences';
import type { NormalizedGame } from '@/lib/types/game';
import type { StockfishEngine } from '@/lib/analysis/stockfishClient';
import { EXPECTED_OWNER_HEADER } from '@/lib/auth/ownerContract';
import { mockAuthModule, mockPrismaModule, prismaMock, setMockUserId } from '../helpers/route-mocks';

const startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 37';
const options = analysisDefaultsToExtractOptions({
    analysisQuality: 'STANDARD', trainingCoveragePreset: 'ALL_CONFIRMED',
    trainingGradingTolerance: 'PRACTICAL',
}, { returnAnalysis: true });
function source(header = '[FEN'): NormalizedGame {
    return {
        id: 'lichess:audit-setup', provider: 'lichess', playedAt: '2026-09-05T00:00:00.000Z',
        timeClass: 'rapid', white: { name: 'opponent' }, black: { name: 'adam' },
        provenance: { username: 'adam', userSide: 'black' },
        pgn: `[Event "audit"]\n[White "opponent"]\n[Black "adam"]\n[SetUp "1"]\n${header} "${startFen}"]\n\n37... Nf6 38. Nc3 *`,
    };
}
function extract(game: NormalizedGame) {
    const engine: StockfishEngine = {
        evalPosition: vi.fn(async ({ fen }) => {
            const first = new Chess(fen).moves({ verbose: true })[0]!;
            const uci = `${first.from}${first.to}${first.promotion ?? ''}`;
            return { fen, score: { type: 'cp' as const, value: 0 }, bestMoveUci: uci, pvUci: [uci] };
        }),
        analyzeMultiPv: vi.fn(async () => { throw new Error('Zero-loss fixture must not reach confirmation'); }),
    };
    return extractTrainingMomentsFromGames({
        games: [game], selectedGameIds: new Set([game.id]), engine, options,
        canonicalSourceGameIdByGameId: new Map([[game.id, 'audit-game']]),
    });
}

describe('standard-analysis audit: PGN setup and decision identity', () => {
    it('accepts v3 provenance and the black-start decision at ply zero', async () => {
        vi.clearAllMocks();
        const game = source();
        const output = await extract(game);
        const analysis = output.analysis!.get(game.id)!;
        expect(output.manifests[0]?.complete).toBe(true);
        expect(analysis.trainingExtraction?.trainingSide).toBe('BLACK');
        expect(analysis.trainingExtraction?.decisions.map((decision) => decision.ply)).toEqual([0]);
        expect(analysis.moves[0]?.uci).toBe('g8f6');

        vi.resetModules();
        setMockUserId('audit-owner');
        mockAuthModule();
        mockPrismaModule();
        prismaMock.analyzedGame.findFirst.mockResolvedValue({
            id: 'audit-game', provider: 'LICHESS', externalId: 'audit-setup',
            pgn: game.pgn, playedAt: new Date(game.playedAt), sourceUsername: 'adam',
            userSide: 'BLACK', whiteName: 'opponent', blackName: 'adam',
        });
        const complete = vi.fn().mockResolvedValue({ run: {id:'run', executionMode:'LOCAL_BROWSER', analysisQuality:'STANDARD', creditCost:0, status:'SUCCEEDED', configHash:output.configHash} });
        vi.doMock('@/lib/services/analysisRuns', async (original) => ({
            ...await original<typeof import('@/lib/services/analysisRuns')>(),
            createAndCompleteLocalAnalysisRun: complete,
        }));
        vi.doMock('@/lib/notifications/delivery', () => ({dispatchPendingNotificationDeliveries: vi.fn().mockResolvedValue(undefined)}));
        const route = await import('@/app/api/games/[id]/analysis/route');
        const send = async (configSnapshot: Record<string, unknown>, configHash: string) => route.PUT(new Request('http://localhost/api/games/audit-game/analysis', {
            method: 'PUT', headers: { 'content-type': 'application/json', [EXPECTED_OWNER_HEADER]: 'audit-owner' },
            body: JSON.stringify({
                analysis, trainingMoments: output.moments, extractionManifest: output.manifests[0],
                analysisQuality: 'STANDARD', configSnapshot, configHash,
            }),
        }), { params: Promise.resolve({ id: 'audit-game' }) });
        const directResponse = await send(output.configSnapshot, output.configHash);
        expect(await directResponse.json()).toMatchObject({ok: true});
        expect(directResponse.status).toBe(200);
        expect(complete).toHaveBeenCalledWith(expect.objectContaining({completion: expect.objectContaining({analysis})}));
    });

    it.each([' [FEN', '[fen'])('replays %s exactly as chess.js does', async (header) => {
        const game = source(header);
        const chess = new Chess();
        chess.loadPgn(game.pgn, { strict: false });
        expect(chess.history({ verbose: true })[0]?.before).toBe(startFen);
        const output = await extract(game);
        expect(output.manifests[0]?.complete).toBe(true);
        expect(output.manifests[0]?.termination).toBe('COMPLETED');
    });
});
