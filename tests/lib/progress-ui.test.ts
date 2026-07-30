import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
    deriveProgressNextAction,
    formatProgressRate,
    formatTrend,
    gamesHref,
    practiceHref,
} from '@/components/progress/model';
import { parseProgressSearchParams } from '@/components/progress/searchParams';
import { appNavItems } from '@/components/nav/AppNav';
import type { ProgressSnapshot } from '@/lib/progress/contracts';
import { progressRate, progressTrend } from '@/lib/progress/metrics';
import { config as proxyConfig } from '@/proxy';

function actionSnapshot(
    overrides: {
        filteredEmpty?: boolean;
        hasDataOutsideScope?: boolean;
        primaryState?:
            | 'NO_LINKED_ACCOUNT'
            | 'NO_GAMES'
            | 'NO_ANALYSIS'
            | 'WAITING_FOR_CREDITS'
            | 'ANALYSIS_RUNNING'
            | 'ANALYSIS_QUEUED'
            | 'ANALYSIS_FAILED'
            | 'READY';
        eligiblePositions?: number;
        fresh?: number;
        attemptedPositionId?: string;
    } = {}
) {
    const attemptedPositionId = overrides.attemptedPositionId;
    return {
        availability: {
            filteredEmpty: overrides.filteredEmpty ?? false,
            hasDataOutsideScope:
                overrides.hasDataOutsideScope ?? false,
        },
        operational: {
            primaryState: overrides.primaryState ?? 'READY',
        },
        inventory: {
            eligiblePositions: overrides.eligiblePositions ?? 0,
            fresh: overrides.fresh ?? 0,
        },
        practice: {
            gradedAttempts: 0,
            revealedAttempts: 0,
            unresolvedExcluded: 0,
        },
        actions: {
            needsAnotherLook: attemptedPositionId
                ? [{ positionId: attemptedPositionId }]
                : [],
            persistentOriginalMoveRepetition: [],
        },
        filters: {
            providers: [],
            timeClasses: [],
        },
        window: {
            from: null,
            asOf: '2026-07-30T00:00:00.000Z',
        },
        coverage: {
            analyzedRate: progressRate(0, 0),
        },
    } as unknown as ProgressSnapshot;
}

describe('Progress information architecture', () => {
    it('uses one canonical route and the requested primary navigation order', () => {
        expect(
            appNavItems.map(({ label, href }) => ({ label, href }))
        ).toEqual([
            { label: 'Home', href: '/home' },
            { label: 'Practice', href: '/practice' },
            { label: 'Play', href: '/play' },
            { label: 'Games', href: '/games' },
            { label: 'Progress', href: '/progress' },
            { label: 'Settings', href: '/settings' },
        ]);
        expect(proxyConfig.matcher).toContain('/progress/:path*');
        expect(proxyConfig.matcher).not.toContain('/stats/:path*');
        expect(proxyConfig.matcher).not.toContain('/insights/:path*');
        expect(existsSync('src/app/progress/page.tsx')).toBe(true);
        expect(existsSync('src/app/stats/page.tsx')).toBe(false);
    });

    it('defaults to 90 days and keeps only valid, canonical filters', () => {
        expect(parseProgressSearchParams({})).toEqual({
            scope: 90,
            filters: { providers: [], timeClasses: [] },
            canonicalQuery: '',
        });
        expect(
            parseProgressSearchParams({
                scope: '28',
                provider: ['lichess', 'CHESSCOM', 'invalid'],
                timeClass: ['rapid', 'BLITZ', 'rapid'],
            })
        ).toEqual({
            scope: 28,
            filters: {
                providers: ['LICHESS', 'CHESSCOM'],
                timeClasses: ['RAPID', 'BLITZ'],
            },
            canonicalQuery:
                'scope=28&provider=LICHESS&provider=CHESSCOM&timeClass=RAPID&timeClass=BLITZ',
        });
    });

    it('keeps fresh Practice entry generic and only deep-links an attempted Position', () => {
        expect(practiceHref()).toBe('/practice?entry=progress');
        expect(practiceHref()).not.toMatch(
            /theme|source|impact|phase|lesson/i
        );
        expect(
            practiceHref('11111111-1111-4111-8111-111111111111')
        ).toBe(
            '/practice?entry=progress&momentId=11111111-1111-4111-8111-111111111111'
        );

        const fresh = deriveProgressNextAction(
            actionSnapshot({ eligiblePositions: 3, fresh: 3 })
        );
        expect(fresh.href).toBe('/practice?entry=progress');

        const reviewed = deriveProgressNextAction(
            actionSnapshot({
                eligiblePositions: 3,
                attemptedPositionId:
                    '11111111-1111-4111-8111-111111111111',
            })
        );
        expect(reviewed.href).toContain('entry=progress');
        expect(reviewed.href).toContain('momentId=');
    });

    it('preserves compatible Progress filters in Games actions', () => {
        const snapshot = {
            filters: {
                providers: ['LICHESS'],
                timeClasses: ['RAPID'],
            },
            window: {
                from: '2026-05-01T00:00:00.000Z',
                asOf: '2026-07-30T00:00:00.000Z',
            },
        } as Pick<ProgressSnapshot, 'filters' | 'window'>;

        expect(gamesHref(snapshot, { unanalyzed: true })).toBe(
            '/games?provider=lichess&timeClass=rapid&since=2026-05-01&until=2026-07-30&analysisState=needs-analysis'
        );
    });

    it('renders counts below ten and exposes percentages only with enough observations', () => {
        expect(formatProgressRate(progressRate(4, 7))).toBe('4 of 7');
        expect(formatProgressRate(progressRate(7, 10))).toBe(
            '70% · 7 of 10'
        );
        expect(formatProgressRate(progressRate(0, 0))).toBe(
            'No observations yet'
        );
        expect(
            formatTrend(
                progressTrend({
                    current: progressRate(35, 50),
                    previous: progressRate(25, 50),
                    allTime: false,
                    comparableConfig: true,
                    comparableCoverage: true,
                    comparableMix: true,
                })
            )
        ).toContain('95% interval for the difference');
    });

    it('prioritizes filtered-empty, onboarding, and operational recovery states', () => {
        expect(
            deriveProgressNextAction(
                actionSnapshot({ filteredEmpty: true })
            ).href
        ).toBe('/progress');
        expect(
            deriveProgressNextAction(
                actionSnapshot({ hasDataOutsideScope: true })
            ).href
        ).toBe('/progress?scope=all');
        expect(
            deriveProgressNextAction(
                actionSnapshot({ primaryState: 'NO_LINKED_ACCOUNT' })
            ).href
        ).toBe('/settings');
        expect(
            deriveProgressNextAction(
                actionSnapshot({ primaryState: 'WAITING_FOR_CREDITS' })
            ).href
        ).toContain('analysisState=needs-analysis');
        expect(
            deriveProgressNextAction(
                actionSnapshot({ primaryState: 'ANALYSIS_FAILED' })
            ).label
        ).toBe('Review Games');
    });
});
