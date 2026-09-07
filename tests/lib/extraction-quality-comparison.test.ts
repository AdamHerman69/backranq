import { describe, expect, it } from 'vitest';
import { compareRootAnswers, snapshotRootAnswers, summarizeRootComparisons, type RootAnswerSnapshot } from '../../scripts/extraction-quality-comparison';
import { practiceV4Fixture } from '../helpers/practice-v4';

function snapshot(bestMoveUci: string, good: string[], below: string[] = [], unknown: string[] = []): RootAnswerSnapshot {
    return { bestMoveUci, acceptedMovesUci: good, belowStandardMovesUci: below, unknownMovesUci: unknown };
}

describe('extraction quality comparison evidence', () => {
    it('keeps a missing alternative UNKNOWN instead of inferring an incompatible best move', () => {
        const row = compareRootAnswers(snapshot('e2e4', ['e2e4'], [], ['d2d4']), snapshot('d2d4', ['d2d4', 'e2e4']));
        expect(row).toMatchObject({ bestMoveCompatibility: 'UNKNOWN', productQualityOfReferenceBest: 'UNKNOWN', referenceQualityOfProductBest: 'GOOD', acceptedMoveJaccard: 0.5, supportedQualityOppositionMovesUci: [] });
        expect(summarizeRootComparisons([row])).toMatchObject({ bestMoveCompatibility: null, bestMoveCompatibilityCounts: { compatible: 0, incompatible: 0, unknown: 1, resolved: 0, total: 1 } });
    });

    it('reports supported opposition even when the opposite direction is unknown', () => {
        const row = compareRootAnswers(snapshot('e2e4', ['e2e4'], ['d2d4']), snapshot('d2d4', ['d2d4']));
        expect(row).toMatchObject({ bestMoveCompatibility: 'INCOMPATIBLE', productQualityOfReferenceBest: 'BELOW_STANDARD', referenceQualityOfProductBest: 'UNKNOWN', supportedQualityOppositionMovesUci: ['d2d4'] });
    });

    it('counts only resolved compatibility, retaining unknown and directional quality counts', () => {
        const compatible = compareRootAnswers(snapshot('e2e4', ['e2e4', 'd2d4']), snapshot('d2d4', ['e2e4', 'd2d4']));
        const incompatible = compareRootAnswers(snapshot('e2e4', ['e2e4'], ['d2d4']), snapshot('d2d4', ['d2d4', 'e2e4']));
        const unknown = compareRootAnswers(snapshot('e2e4', ['e2e4']), snapshot('d2d4', ['d2d4']));
        expect(summarizeRootComparisons([compatible, incompatible, unknown])).toEqual({
            bestMoveCompatibility: 0.5,
            bestMoveCompatibilityCounts: { compatible: 1, incompatible: 1, unknown: 1, resolved: 2, total: 3 },
            productQualityOfReferenceBestCounts: { GOOD: 1, BELOW_STANDARD: 1, UNKNOWN: 1 },
            referenceQualityOfProductBestCounts: { GOOD: 2, BELOW_STANDARD: 0, UNKNOWN: 1 },
        });
        expect(summarizeRootComparisons([]).bestMoveCompatibility).toBeNull();
    });

    it('does not mistake identical preferred move labels for supported compatibility', () => {
        expect(compareRootAnswers(snapshot('e2e4', []), snapshot('e2e4', ['e2e4']))).toMatchObject({ exactBestMove: true, bestMoveCompatibility: 'UNKNOWN' });
    });

    it('retains supported opposition on non-preferred moves separately from best compatibility', () => {
        const row = compareRootAnswers(snapshot('e2e4', ['e2e4', 'd2d4']), snapshot('e2e4', ['e2e4'], ['d2d4']));
        expect(row).toMatchObject({ bestMoveCompatibility: 'COMPATIBLE', supportedQualityOppositionMovesUci: ['d2d4'], acceptedMoveJaccard: 0.5 });
    });

    it('projects only current root answers, excluding continuation assessments and provisional quality', () => {
        const manifest = practiceV4Fixture();
        const original = manifest.assessments.find(a => a.moveUci === 'a2a3')!;
        expect(snapshotRootAnswers(manifest)).toMatchObject({ acceptedMovesUci: ['d2d4', 'e2e4'], belowStandardMovesUci: ['a2a3'] });
        manifest.assessments.push({ ...original, id: 'continuation', contextId: 'other-context', moveUci: 'h2h3', quality: 'GOOD', qualitySupport: 'SUPPORTED' });
        original.qualitySupport = 'PROVISIONAL';
        const answers = snapshotRootAnswers(manifest);
        expect(answers.acceptedMovesUci).toEqual(['d2d4', 'e2e4']);
        expect(answers.belowStandardMovesUci).toEqual([]);
        expect(answers.unknownMovesUci).toContain('a2a3');
        expect(answers.unknownMovesUci).toContain('h2h3');
    });

    it('does not project stale or missing frame evidence as supported answers', () => {
        const manifest = practiceV4Fixture();
        manifest.frames[0].status = 'SUPERSEDED';
        expect(snapshotRootAnswers(manifest)).toMatchObject({ acceptedMovesUci: [], belowStandardMovesUci: [], unknownMovesUci: manifest.rootAnswerIndex.legalMovesUci });
        manifest.frames = [];
        expect(snapshotRootAnswers(manifest)).toMatchObject({ acceptedMovesUci: [], belowStandardMovesUci: [], unknownMovesUci: manifest.rootAnswerIndex.legalMovesUci });
    });
});
