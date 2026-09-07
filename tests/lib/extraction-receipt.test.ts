import { emptyExtractionWork, extractionWorkSince, isExtractionWork } from '@/lib/analysis/extractionWork';
import { describe, expect, it } from 'vitest';

import {
    emptyExtractionReasonCounts,
    isTrainingExtractionReceipt,
    type TrainingExtractionReceipt,
} from '@/lib/analysis/extractionReceipt';

function receipt(): TrainingExtractionReceipt {
    const reasons = emptyExtractionReasonCounts();
    reasons.MISTAKE_CONFIRMED = 1;
    return {
        version: 2,
        engineWork: emptyExtractionWork(),
        trainingSide: 'WHITE',
        thresholds: {
            minWinChanceLoss: 0.03,
            fallbackMinCpLoss: 30,
        },
        budgets: {
            scanNodes: 100_000,
            confirmationBaseNodes: 200_000,
            confirmationMaxNodes: 800_000,
            multiPvStart: 5,
            multiPvMax: 16,
        },
        summary: {
            userDecisions: 1,
            savedPositions: 1,
            unresolvedDecisions: 0,
            reasons,
        },
        decisions: [
            {
                ply: 12,
                status: 'SAVED',
                reason: 'MISTAKE_CONFIRMED',
                cpLoss: 95,
                winChanceLoss: 0.08,
                confirmation: {
                    version: 2,
                    stable: true,
                    termination: 'STABLE',
                    passes: [
                        {
                            nodes: 200_000,
                            purpose: 'MISSING_MOVE',
                            searchId: 'physical-original',
                            outcome: 'RETURNED',
                            bestMoveUci: 'g1f3',
                            qualifies: true,
                            cpLoss: 95,
                            winChanceLoss: 0.08,
                        },
                    ],
                },
                sourceKinds: ['MY_MISTAKE'],
            },
        ],
    };
}

describe('training extraction receipt', () => {
    it('accounts for prior slices and per-game deltas without losing failed or reused work', () => {
        const counts = { ...emptyExtractionWork(), queries: 4, reusedQueries: 1, failedQueries: 1,
            unattributedFailedQueries: 1, unattributedFailedRequestedNodes: 100,
            physicalSearches: 2, requestedNodes: 400, reportedNodes: 410, reportedTimeMs: 12 };
        const { byReason: _unused, ...values } = counts;
        void _unused;
        const total = { ...counts, byReason: { GAME_SCAN: values } };
        expect(isExtractionWork(total)).toBe(true);
        expect(extractionWorkSince(total, emptyExtractionWork())).toEqual(total);
        expect(extractionWorkSince(total, total)).toEqual(emptyExtractionWork());
        const invalid = receipt();
        invalid.engineWork = { ...total, reportedNodes: 411 };
        expect(isTrainingExtractionReceipt(invalid)).toBe(false);
    });
    it('accepts a bounded internally consistent receipt', () => {
        expect(isTrainingExtractionReceipt(receipt())).toBe(true);
    });

    it('rejects inconsistent summaries and duplicate physical work identities', () => {
        const invalidSummary = receipt();
        invalidSummary.summary.savedPositions = 0;
        expect(isTrainingExtractionReceipt(invalidSummary)).toBe(false);

        const invalidPasses = receipt();
        invalidPasses.decisions[0]!.confirmation!.passes.push({
            ...invalidPasses.decisions[0]!.confirmation!.passes[0]!,
            nodes: 100_000,
        });
        expect(isTrainingExtractionReceipt(invalidPasses)).toBe(false);
    });

    it('preserves actual nonmonotone dependency order and allows entirely reused proof', () => {
        const value = receipt();
        const row = value.decisions[0]!.confirmation!.passes[0]!;
        value.decisions[0]!.confirmation!.passes = [
            { ...row, nodes: 200_000, purpose: 'MISSING_REFERENCE', searchId: 'root', qualifies: false },
            { ...row, nodes: 400_000, purpose: 'VERIFY_REFERENCE', searchId: 'probe', qualifies: false },
            { ...row, nodes: 200_000, purpose: 'MISSING_MOVE', searchId: 'original' },
        ];
        expect(isTrainingExtractionReceipt(value)).toBe(true);
        value.decisions[0]!.confirmation!.passes = [];
        expect(isTrainingExtractionReceipt(value)).toBe(true);
    });

    it('rejects missing physical identity and obsolete paired-pass evidence', () => {
        const missing = receipt();
        missing.decisions[0]!.confirmation!.passes[0]!.searchId = null;
        expect(isTrainingExtractionReceipt(missing)).toBe(false);
        missing.decisions[0]!.confirmation!.passes[0]!.outcome = 'UNATTRIBUTED';
        expect(isTrainingExtractionReceipt(missing)).toBe(true);
        const obsolete = JSON.parse(JSON.stringify(receipt()));
        obsolete.decisions[0].confirmation.version = 1;
        expect(isTrainingExtractionReceipt(obsolete)).toBe(false);
    });

    it('rejects contradictory confirmation evidence and partial node budgets', () => {
        const contradictory = receipt();
        contradictory.decisions[0]!.confirmation!.stable = false;
        expect(isTrainingExtractionReceipt(contradictory)).toBe(false);

        const unstableSaved = receipt();
        unstableSaved.decisions[0]!.confirmation = {
            ...unstableSaved.decisions[0]!.confirmation!,
            stable: false,
            termination: 'MAX_BUDGET_UNSTABLE',
        };
        expect(isTrainingExtractionReceipt(unstableSaved)).toBe(false);

        const partialBudgets = receipt();
        partialBudgets.budgets.confirmationMaxNodes = null;
        expect(isTrainingExtractionReceipt(partialBudgets)).toBe(false);
    });
});
