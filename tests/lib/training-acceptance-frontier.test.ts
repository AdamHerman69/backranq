import { describe, expect, it } from 'vitest';

import type { MultiPvLine } from '@/lib/analysis/stockfishClient';
import {
    acceptanceFrontierFromMultiPv,
    confirmAcceptanceFrontier,
} from '@/lib/training/acceptanceFrontier';
import { normalizeGradingPolicy } from '@/lib/training/config';

const policy = normalizeGradingPolicy(undefined);

function lines(losses: number[]): MultiPvLine[] {
    return losses.map((loss, index) => ({
        multipv: index + 1,
        pvUci: [
            [
                'a2a3',
                'b2b3',
                'c2c3',
                'd2d3',
                'e2e3',
                'f2f3',
                'g2g3',
                'h2h3',
            ][index]!,
        ],
        score: { type: 'cp', value: 500 - loss },
    }));
}

describe('authoritative accepted-move frontier', () => {
    it('assigns BEST, STRONG, and GOOD tiers as one monotone prefix', () => {
        const frontier = acceptanceFrontierFromMultiPv({
            lines: lines([0, 20, 50, 90, 100, 160]),
            requestedMultiPv: 6,
            policy,
        });

        expect(frontier).toMatchObject({
            status: 'STABLE',
            targetCutoffCp: 100,
            boundaryGapCp: null,
            firstRejectedMoveUci: 'f2f3',
            moves: [
                { moveUci: 'a2a3', tier: 'BEST' },
                { moveUci: 'b2b3', tier: 'BEST' },
                { moveUci: 'c2c3', tier: 'STRONG' },
                { moveUci: 'd2d3', tier: 'GOOD' },
                { moveUci: 'e2e3', tier: 'GOOD' },
            ],
        });
    });

    it('does not silently expand tolerance for a near-equal cluster', () => {
        const frontier = acceptanceFrontierFromMultiPv({
            lines: lines([0, 90, 100, 110, 160]),
            requestedMultiPv: 5,
            policy,
        });

        expect(frontier.status).toBe('STABLE');
        expect(frontier.moves.map((move) => move.moveUci)).toEqual([
            'a2a3',
            'b2b3',
            'c2c3',
        ]);
        expect(frontier.firstRejectedMoveUci).toBe('d2d3');
    });

    it('retains individually supported answers despite an unresolved cluster', () => {
        const frontier = acceptanceFrontierFromMultiPv({
            lines: lines([0, 90, 100, 115, 130, 145]),
            requestedMultiPv: 6,
            policy,
        });

        expect(frontier.status).toBe('STABLE');
        expect(frontier.effectiveCutoffCp).toBeNull();
    });

    it('rejects a MultiPV snapshot whose advertised ranking contradicts its scores', () => {
        const frontier = acceptanceFrontierFromMultiPv({
            lines: lines([0, 90, 40, 160]),
            requestedMultiPv: 4,
            policy,
        });

        expect(frontier.status).toBe('UNSTABLE');
    });

    it('rejects duplicate root moves instead of treating them as coverage', () => {
        const duplicated = lines([0, 40, 150]);
        duplicated[1] = {
            ...duplicated[1]!,
            pvUci: duplicated[0]!.pvUci,
        };

        expect(
            acceptanceFrontierFromMultiPv({
                lines: duplicated,
                requestedMultiPv: 3,
                policy,
            }).status
        ).toBe('UNSTABLE');
    });

    it('keeps confirmation stable when equally graded accepted moves change rank', () => {
        const first = acceptanceFrontierFromMultiPv({
            lines: lines([0, 20, 160]),
            requestedMultiPv: 3,
            policy,
        });
        const reordered = lines([0, 20, 160]);
        reordered[0]!.pvUci = ['b2b3'];
        reordered[1]!.pvUci = ['a2a3'];
        const confirmation = acceptanceFrontierFromMultiPv({
            lines: reordered,
            requestedMultiPv: 3,
            policy,
        });

        expect(first.status).toBe('STABLE');
        expect(confirmation.status).toBe('STABLE');
        expect(confirmAcceptanceFrontier(first, confirmation)).toEqual(
            confirmation
        );
    });

    it('retains common answers when marginal membership changes', () => {
        const first = acceptanceFrontierFromMultiPv({
            lines: lines([0, 20, 160]),
            requestedMultiPv: 3,
            policy,
        });
        const changed = lines([0, 20, 160]);
        changed[1]!.pvUci = ['h2h3'];
        const confirmation = acceptanceFrontierFromMultiPv({
            lines: changed,
            requestedMultiPv: 3,
            policy,
        });

        expect(first.status).toBe('STABLE');
        expect(confirmation.status).toBe('STABLE');
        expect(confirmAcceptanceFrontier(first, confirmation).status).toBe(
            'STABLE'
        );
    });

    it('retains conservative tiers when membership is unchanged', () => {
        const first = acceptanceFrontierFromMultiPv({
            lines: lines([0, 40, 90, 150]),
            requestedMultiPv: 4,
            policy,
        });
        const changed = acceptanceFrontierFromMultiPv({
            lines: lines([0, 55, 90, 150]),
            requestedMultiPv: 4,
            policy,
        });

        expect(first.status).toBe('STABLE');
        expect(changed.status).toBe('STABLE');
        expect(confirmAcceptanceFrontier(first, changed).status).toBe(
            'STABLE'
        );
    });
});
