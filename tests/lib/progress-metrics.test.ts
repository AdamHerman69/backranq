import { describe, expect, it } from 'vitest';
import {
    distributionsComparable,
    newcombeWilson95Difference,
    progressRate,
    progressTrend,
} from '@/lib/progress/metrics';

describe('progress metrics guardrails', () => {
    it('shows counts only below 10 and Wilson intervals from 10 onward', () => {
        expect(progressRate(4, 9)).toEqual({
            x: 4,
            n: 9,
            rate: null,
            sampleState: 'COUNTS_ONLY',
            confidence95: null,
        });

        const early = progressRate(6, 10);
        expect(early).toMatchObject({
            x: 6,
            n: 10,
            rate: 0.6,
            sampleState: 'EARLY_SIGNAL',
        });
        expect(early.confidence95?.low).toBeLessThan(0.6);
        expect(early.confidence95?.high).toBeGreaterThan(0.6);
        expect(progressRate(30, 50).sampleState).toBe('ESTABLISHED');
    });

    it('withholds trends unless both samples and every comparability gate pass', () => {
        expect(
            progressTrend({
                current: progressRate(35, 50),
                previous: progressRate(28, 49),
                allTime: false,
                comparableConfig: true,
                comparableCoverage: true,
                comparableMix: true,
            })
        ).toMatchObject({
            status: 'HIDDEN',
            reason: 'PREVIOUS_SAMPLE_TOO_SMALL',
        });
        expect(
            progressTrend({
                current: progressRate(35, 50),
                previous: progressRate(25, 50),
                allTime: false,
                comparableConfig: false,
                comparableCoverage: true,
                comparableMix: true,
            })
        ).toMatchObject({
            status: 'HIDDEN',
            reason: 'CONFIG_CHANGED',
        });

        const shown = progressTrend({
            current: progressRate(35, 50),
            previous: progressRate(25, 50),
            allTime: false,
            comparableConfig: true,
            comparableCoverage: true,
            comparableMix: true,
        });
        expect(shown).toMatchObject({
            status: 'SHOWN',
            reason: 'AVAILABLE',
        });
        expect(shown.difference).toBeCloseTo(0.2);
        expect(shown.confidence95Difference).not.toBeNull();
    });

    it('uses the Newcombe-Wilson interval for a difference of proportions', () => {
        const interval = newcombeWilson95Difference(60, 100, 40, 100);

        expect(interval?.low).toBeCloseTo(0.0614107292, 8);
        expect(interval?.high).toBeCloseTo(0.3281259295, 8);
    });

    it('uses a 15 percentage-point category mix tolerance', () => {
        expect(
            distributionsComparable(
                new Map([
                    ['RAPID', 65],
                    ['BLITZ', 35],
                ]),
                new Map([
                    ['RAPID', 50],
                    ['BLITZ', 50],
                ])
            )
        ).toBe(true);
        expect(
            distributionsComparable(
                new Map([
                    ['RAPID', 66],
                    ['BLITZ', 34],
                ]),
                new Map([
                    ['RAPID', 50],
                    ['BLITZ', 50],
                ])
            )
        ).toBe(false);
    });
});
