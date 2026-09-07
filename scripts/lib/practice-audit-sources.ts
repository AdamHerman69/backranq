import { Chess, type Move } from 'chess.js';
import { hashSourcePgn } from '@/lib/chess/pgn';
import { ruleTerminalEvaluation } from '@/lib/analysis/ruleEvaluation';
import { canonicalJson, practiceContextId, type SourceDecision } from '@/lib/training/practiceContract';
import type { NormalizedGame } from '@/lib/types/game';

const sourceKeys = ['gameId', 'sourcePgnHash', 'decisionPly', 'contextId', 'fen', 'positionHistory', 'trainingSide', 'originalMoveUci'];
function exactKeys(value: unknown, keys: string[], label: string): asserts value is Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw new Error(`Invalid ${label} fields`);
}

/** Additional direct source positions, never extractor-emitted evidence. Every
 * field is reconstructed from an existing corpus PGN before accepting a row.
 * The caller fingerprints the original sidecar bytes along with the corpus. */
export function loadAdditionalAuditSources(raw: string, corpus: { games: NormalizedGame[] }, existing: SourceDecision[]): SourceDecision[] {
    const input: unknown = JSON.parse(raw);
    exactKeys(input, ['version', 'sources'], 'audit source sidecar');
    if (input.version !== 1 || !Array.isArray(input.sources) || !input.sources.length) throw new Error('Audit source sidecar requires version1 and nonempty sources');
    const games = new Map<string, NormalizedGame>();
    for (const game of corpus.games) {
        if (games.has(game.id)) throw new Error('Ambiguous duplicate corpus game ID');
        games.set(game.id, game);
    }
    const replays = new Map<string, Move[]>();
    const combined = new Map<string, SourceDecision>();
    const append = (source: SourceDecision) => {
        const prior = combined.get(source.contextId);
        if (prior && canonicalJson(prior) !== canonicalJson(source)) throw new Error('Conflicting duplicate audit context');
        if (!prior) combined.set(source.contextId, structuredClone(source));
    };
    for (const source of existing) append(source);
    for (const value of input.sources) {
        exactKeys(value, sourceKeys, 'audit source');
        if (typeof value.gameId !== 'string' || !Number.isSafeInteger(value.decisionPly) || Number(value.decisionPly) < 0) throw new Error('Invalid audit source game/ply');
        const game = games.get(value.gameId);
        if (!game || game.id.startsWith('exact-edge-')) throw new Error('Additional audit source must reference a real corpus game');
        let replay = replays.get(game.id);
        if (!replay) {
            const board = new Chess(); board.loadPgn(game.pgn);
            replay = board.history({ verbose: true }); replays.set(game.id, replay);
        }
        const moves = replay;
        const ply = Number(value.decisionPly); const move = moves[ply];
        if (!move) throw new Error('Audit source ply is outside the recorded game');
        const positionHistory = moves.slice(0, ply).map(move => move.before);
        const trainingSide = move.color === 'w' ? 'WHITE' : 'BLACK';
        const expected: SourceDecision = { gameId: game.id, sourcePgnHash: hashSourcePgn(game.pgn), decisionPly: ply,
            fen: move.before, positionHistory, trainingSide, originalMoveUci: move.lan,
            contextId: practiceContextId(move.before, positionHistory, trainingSide) };
        if (canonicalJson(value) !== canonicalJson(expected)) throw new Error('Audit source differs from the exact corpus PGN replay');
        if (ruleTerminalEvaluation(expected.fen, expected.positionHistory)) throw new Error('Additional audit source is already a mandatory terminal position');
        append(expected);
    }
    return [...combined.values()];
}
