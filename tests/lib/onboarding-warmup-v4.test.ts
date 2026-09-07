import { createHash } from 'node:crypto';
import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import { WARMUP_MANIFEST, WARMUP_PUZZLE } from '@/lib/onboarding/warmupPuzzle';
import { canonicalPracticeSemantics, parsePracticeMomentRevision, canonicalJson } from '@/lib/training/practiceContract';
import { lookupAnswer } from '@/lib/training/answerIndex';
import { stableCanonicalStringify } from '@/lib/training/contracts';

describe('v4 rule-exact onboarding warmup', () => {
    it('is a validated canonical INCLUDED moment with a correct precomputed semantic hash', () => {
        expect(parsePracticeMomentRevision(WARMUP_MANIFEST)).toEqual(WARMUP_MANIFEST);
        expect(WARMUP_MANIFEST.decision.selection).toBe('INCLUDED');
        const semantic = canonicalPracticeSemantics(WARMUP_MANIFEST);
        expect(canonicalJson(semantic)).toBe(stableCanonicalStringify(semantic));
        expect(createHash('sha256').update(canonicalJson(semantic)).digest('hex')).toBe(WARMUP_MANIFEST.semanticHash);
        expect(WARMUP_PUZZLE.prompt.grading).toBe(WARMUP_MANIFEST);
    });
    it('classifies only independently verifiable immediate mates and terminal draws', () => {
        expect(Object.keys(WARMUP_MANIFEST.evidence.searches)).toHaveLength(0);
        expect(Object.keys(WARMUP_MANIFEST.evidence.observations)).toHaveLength(0);
        for (const uci of WARMUP_MANIFEST.rootAnswerIndex.legalMovesUci) {
            const board = new Chess(WARMUP_MANIFEST.source.fen);
            board.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
            const answer = lookupAnswer(WARMUP_MANIFEST.rootAnswerIndex, uci, WARMUP_MANIFEST.assessments, []);
            if (board.isCheckmate()) expect(answer.quality).toBe('GOOD');
            else if (board.isStalemate()) expect(answer.quality).toBe('BELOW_STANDARD');
            else expect(answer.kind).toBe('PENDING');
        }
        expect(WARMUP_MANIFEST.rootAnswerIndex.readiness).toBe('PARTIAL');
        expect(WARMUP_MANIFEST.rootAnswerIndex.unresolvedMovesUci.length).toBeGreaterThan(0);
    });
    it('derives presentation answers from the supported index and preserves rule provenance', () => {
        expect(WARMUP_PUZZLE.prompt.review.acceptedMovesUci.sort()).toEqual(['f7e8', 'f7f8', 'f7g7', 'f7h7']);
        expect(WARMUP_MANIFEST.assessments.every(a => a.source === 'RULE')).toBe(true);
        const repeated = lookupAnswer(WARMUP_MANIFEST.rootAnswerIndex, 'f7e6', WARMUP_MANIFEST.assessments, []);
        expect(repeated.kind).toBe('INDIVIDUAL'); expect(repeated.assessment?.originalRelation).toBe('SAME_MOVE');
        expect(repeated.assessment?.metrics.lossCp).toBeNull();
    });
});
