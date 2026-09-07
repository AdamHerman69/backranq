import { practiceV4Fixture } from '../helpers/practice-v4';
import { describe, expect, it } from 'vitest';

import {
    mergeTrainingMomentMetadata,
    stableCanonicalStringify,
} from '@/lib/training/contracts';
import {
    hashCanonicalTrainingValue,
    solutionSemanticsHash,
    trainingMomentKey,
} from '@/lib/training/contractHashes.server';
import {
    normalizeGradingPolicy,
    resolveTrainingConfig,
} from '@/lib/training/config';
import { trainingConfigHash } from '@/lib/training/configHash.server';

describe('training moment contracts', () => {
    it('creates a canonical moment key from game, PGN revision and decision ply', () => {
        const canonical = trainingMomentKey({
            gameId: '11111111-1111-4111-8111-111111111111',
            sourcePgnHash: 'ABCDEF',
            decisionPly: 31,
        });
        const normalized = trainingMomentKey({
            gameId: ' 11111111-1111-4111-8111-111111111111 ',
            sourcePgnHash: ' abcdef ',
            decisionPly: 31,
        });

        expect(canonical).toBe(normalized);
        expect(canonical).toMatch(/^[a-f0-9]{64}$/);
        expect(
            trainingMomentKey({
                gameId: '11111111-1111-4111-8111-111111111111',
                sourcePgnHash: 'different-pgn',
                decisionPly: 31,
            })
        ).not.toBe(canonical);
        expect(
            trainingMomentKey({
                gameId: '11111111-1111-4111-8111-111111111111',
                sourcePgnHash: 'abcdef',
                decisionPly: 32,
            })
        ).not.toBe(canonical);
    });

    it('rejects incomplete or unsafe moment identities', () => {
        expect(() =>
            trainingMomentKey({
                gameId: '',
                sourcePgnHash: 'hash',
                decisionPly: 1,
            })
        ).toThrow(/gameId is required/);
        expect(() =>
            trainingMomentKey({
                gameId: 'game',
                sourcePgnHash: 'hash',
                decisionPly: -1,
            })
        ).toThrow(/decisionPly/);
        expect(() =>
            trainingMomentKey({
                gameId: 'game',
                sourcePgnHash: 'hash',
                decisionPly: 1.5,
            })
        ).toThrow(/decisionPly/);
    });

    it('merges avoid and punish reasons into one deterministic metadata set', () => {
        const metadata = mergeTrainingMomentMetadata(
            {
                sourceKinds: ['MISSED_OPPORTUNITY'],
                lessonKinds: ['PUNISH_MISTAKE'],
                themes: [' quietMove ', 'defensiveMove'],
            },
            {
                sourceKinds: ['MY_MISTAKE', 'MISSED_OPPORTUNITY'],
                lessonKinds: ['AVOID_MISTAKE', 'PUNISH_MISTAKE'],
                themes: ['quietMove'],
            }
        );

        expect(metadata).toEqual({
            sourceKinds: ['MY_MISTAKE', 'MISSED_OPPORTUNITY'],
            lessonKinds: ['AVOID_MISTAKE', 'PUNISH_MISTAKE'],
            themes: ['defensivemove', 'quietmove'],
        });
    });

    it('hashes canonical JSON independently of object key order', () => {
        const left = {
            z: 1,
            nested: { b: true, a: ['x', 2] },
            omitted: undefined,
        };
        const right = {
            nested: { a: ['x', 2], b: true },
            z: 1,
        };

        expect(stableCanonicalStringify(left)).toBe(
            stableCanonicalStringify(right)
        );
        expect(hashCanonicalTrainingValue(left)).toBe(
            hashCanonicalTrainingValue(right)
        );
    });

    it('hashes grading semantics independently of physical IDs and assessment array order', () => {
        const manifest = practiceV4Fixture();
        const base = { manifest, configHash: 'config' };
        const reordered = structuredClone(base);
        reordered.manifest.assessments.reverse();
        reordered.manifest.momentId = 'another-physical-moment';
        reordered.manifest.revisionId = 'another-physical-revision';
        expect(solutionSemanticsHash(reordered)).toBe(solutionSemanticsHash(base));
        reordered.manifest.policySnapshot.minToleranceCp = 110;
        expect(solutionSemanticsHash(reordered)).not.toBe(solutionSemanticsHash(base));
    });
});

describe('training config normalization', () => {
    it('defaults to broad scan coverage with adaptive practice-v4 grading', () => {
        expect(resolveTrainingConfig()).toMatchObject({ version: 4, coveragePreset: 'ALL_CONFIRMED',
            minWinChanceLoss: 0.03, fallbackMinCpLoss: 30, gradingTolerance: 'PRACTICAL',
            gradingPolicy: { version: 4, minToleranceCp: 100, maxToleranceCp: 300, winningToleranceFraction: 0.6, maxExpectedScoreLoss: 0.1 } });
    });
    it('rejects malformed policies instead of silently changing the declared contract', () => {
        const policy = normalizeGradingPolicy(undefined);
        expect(() => normalizeGradingPolicy({ ...policy, bestMaxLossCp: 500 })).toThrow('Invalid v4');
        expect(() => normalizeGradingPolicy({ ...policy, maxExpectedScoreLoss: 2 })).toThrow('Invalid v4');
        expect(() => normalizeGradingPolicy({ ...policy, minToleranceCp: Number.NaN })).toThrow('Invalid v4');
    });
    it('preserves preset-specific scan and grading defaults', () => {
        const strict = resolveTrainingConfig({ coveragePreset: 'HIGH_CONFIDENCE', gradingTolerance: 'STRICT' });
        const lenient = resolveTrainingConfig({ gradingTolerance: 'LENIENT' });
        expect(strict.minWinChanceLoss).toBe(0.12);
        expect(strict.gradingPolicy.minToleranceCp).toBeLessThan(lenient.gradingPolicy.minToleranceCp);
        expect(strict.gradingPolicy.id).not.toBe(lenient.gradingPolicy.id);
    });
    it('produces the same hash for raw and already-resolved equivalent config', () => {
        const raw = { coveragePreset: 'BALANCED' as const, gradingTolerance: 'STRICT' as const };
        expect(trainingConfigHash(raw)).toBe(trainingConfigHash(resolveTrainingConfig(raw)));
    });
});
