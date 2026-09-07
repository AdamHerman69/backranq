import { expect, it, vi } from 'vitest';
import { loadPracticeReassessmentTargets } from '@/lib/training/reassessmentTargets.server';
import { readPracticeReassessmentTargets } from '@/lib/training/reassessmentTargets';
import { hashSourcePgn } from '@/lib/chess/pgn';

const expected = { ownerId: 'owner', gameId: 'game', pgn: '1. e4 e5 *' };
function payload() {
    return { ownerId: expected.ownerId, game: { id: expected.gameId, pgn: expected.pgn },
        reassessment: { sourcePgnHash: hashSourcePgn(expected.pgn), decisionPlies: [0, 4] } };
}

it('targets only non-archived canonical moments for this owner and exact PGN hash', async () => {
    const findMany = vi.fn().mockResolvedValue([{ decisionPly: 0 }, { decisionPly: 4 }, { decisionPly: 4 }]);
    const result = await loadPracticeReassessmentTargets({ db: { trainingMoment: { findMany } } as never,
        userId: expected.ownerId, gameId: expected.gameId, pgn: expected.pgn });
    expect(findMany).toHaveBeenCalledWith({ where: { userId: 'owner', gameId: 'game', sourcePgnHash: hashSourcePgn(expected.pgn),
        archivedAt: null, currentSolutionRevisionId: { not: null } }, select: { decisionPly: true }, orderBy: { decisionPly: 'asc' } });
    expect(result).toEqual(payload().reassessment);
});

it('passes fresh prior decision targets to browser analysis', () => {
    expect(readPracticeReassessmentTargets(payload(), expected)).toEqual([0, 4]);
});

it.each(['owner', 'game', 'pgn', 'negative', 'fraction', 'missing'] as const)('rejects mismatched or malformed targeting metadata: %s', kind => {
    const value = payload();
    if (kind === 'owner') value.ownerId = 'different-owner';
    if (kind === 'game') value.game.id = 'different-game';
    if (kind === 'pgn') value.game.pgn = '1. d4 d5 *';
    if (kind === 'negative') value.reassessment.decisionPlies = [-1];
    if (kind === 'fraction') value.reassessment.decisionPlies = [0.5];
    expect(() => readPracticeReassessmentTargets(kind === 'missing' ? { game: value.game } : value, expected)).toThrow(/Game or account changed/);
});
