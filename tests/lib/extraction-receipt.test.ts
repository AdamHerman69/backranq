import { describe, expect, it } from 'vitest';

import {
    emptyExtractionReasonCounts,
    isTrainingExtractionReceipt,
    type TrainingExtractionReceipt,
} from '@/lib/analysis/extractionReceipt';

function receipt(): TrainingExtractionReceipt {
    const reasons = emptyExtractionReasonCounts();
    reasons.SAVED = 1;
    return {
        version: 1,
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
                reason: 'SAVED',
                cpLoss: 95,
                winChanceLoss: 0.08,
                confirmation: {
                    version: 1,
                    stable: true,
                    termination: 'STABLE',
                    passes: [
                        {
                            nodes: 200_000,
                            bestMoveUci: 'g1f3',
                            qualifies: true,
                            cpLoss: 95,
                            winChanceLoss: 0.08,
                        },
                    ],
                },
                verificationStatus: 'VERIFIED',
                sourceKinds: ['MY_MISTAKE'],
            },
        ],
    };
}

describe('training extraction receipt', () => {
    it('accepts a bounded internally consistent receipt', () => {
        expect(isTrainingExtractionReceipt(receipt())).toBe(true);
    });

    it('rejects inconsistent summaries and non-increasing confirmation budgets', () => {
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
