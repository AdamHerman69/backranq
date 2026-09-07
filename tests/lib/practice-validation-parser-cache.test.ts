import { Chess } from 'chess.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parsePracticeMomentRevision, validatePracticeEvaluationPatch } from '@/lib/training/practiceContract';
import { practiceV4Fixture, practiceV4PatchFixture } from '../helpers/practice-v4';
import { practicePositionFixture } from '../helpers/practice-position';

afterEach(() => vi.restoreAllMocks());

describe('invocation-scoped parser chess facts', () => {
    it('replays each distinct PV once across structural and assessment checks, and starts fresh next parse', () => {
        const revision = practiceV4Fixture();
        const move = vi.spyOn(Chess.prototype, 'move');
        expect(parsePracticeMomentRevision(revision)).toEqual(revision);
        // Three distinct legal PVs occur at three depths and in three assessments.
        expect(move).toHaveBeenCalledTimes(3);
        parsePracticeMomentRevision(revision);
        expect(move).toHaveBeenCalledTimes(6);
    });

    it('shares legal facts across canonical and patch records but still rejects a changed PV with unchanged IDs', () => {
        const revision = practiceV4Fixture(); const patch = practiceV4PatchFixture(revision);
        const move = vi.spyOn(Chess.prototype, 'move');
        expect(validatePracticeEvaluationPatch(revision, patch).success).toBe(true);
        expect(move).toHaveBeenCalledTimes(3);
        Object.values(patch.evidence.observations)[0].lines[0].pvUci.push('e2e3');
        const invalid = validatePracticeEvaluationPatch(revision, patch);
        expect(invalid.success).toBe(false);
        if (!invalid.success) expect(invalid.issues.join()).toMatch(/illegal|incompatible observation/);
    });

    it.each(['scope', 'bound', 'completion', 'cost'] as const)('never caches evidence validity across same-ID %s changes', change => {
        const revision = practiceV4Fixture(); const patch = practiceV4PatchFixture(revision);
        expect(validatePracticeEvaluationPatch(revision, patch).success).toBe(true);
        const observation = Object.values(patch.evidence.observations)[0];
        const search = patch.evidence.searches[observation.searchId];
        if (change === 'scope') observation.rootScopeUci = ['a2a3'];
        if (change === 'bound') observation.lines[0].bound = 'UPPER';
        if (change === 'completion') search.completion = 'FAILED';
        if (change === 'cost') search.reportedNodes = 1;
        expect(validatePracticeEvaluationPatch(revision, patch).success).toBe(false);
    });
});

describe('history transition equivalence using chess.js Move.after', () => {
    it.each([
        ['initial double push', new Chess().fen(), 'e2e4'],
        ['castling', 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', 'e1g1'],
        ['en passant', '4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1', 'e5d6'],
        ['underpromotion', '4k3/P7/8/8/8/8/8/4K3 w - - 0 1', 'a7a8n'],
    ])('retains full FEN equivalence and rejects changed counters after %s', (_label, fen, uci) => {
        const board = new Chess(fen);
        for (const legal of board.moves({ verbose: true })) {
            board.move(legal);
            expect(legal.after).toBe(board.fen());
            board.undo();
        }
        board.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
        const moves = board.moves({ verbose: true });
        const toUci = (move: typeof moves[number]) => `${move.from}${move.to}${move.promotion ?? ''}`;
        const args = { fen: board.fen(), positionHistory: [fen], bestMoveUci: toUci(moves[0]), originalMoveUci: toUci(moves[1]) };
        expect(() => practicePositionFixture(args)).not.toThrow();
        const changed = args.fen.split(' '); changed[5] = String(Number(changed[5]) + 1);
        expect(() => practicePositionFixture({ ...args, fen: changed.join(' ') })).toThrow(/non-legal transition/);
    });
});
