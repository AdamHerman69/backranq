import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ProgressDashboard } from '@/components/progress/ProgressDashboard';
import { aggregateProgressSnapshot } from '@/lib/progress/aggregate';
import { progressRate } from '@/lib/progress/metrics';

describe('Progress dashboard rendering', () => {
    it('keeps scope and trust visible in the no-account state', () => {
        const snapshot = aggregateProgressSnapshot({
            request: {
                scope: 90,
                asOf: new Date('2026-07-30T00:00:00.000Z'),
                filters: { providers: [], timeClasses: [] },
            },
            user: {
                lichessUsername: null,
                chesscomUsername: null,
                serverCreditsBalance: null,
            },
            games: [],
            positions: [],
            attempts: [],
        });

        const html = renderToStaticMarkup(
            createElement(ProgressDashboard, { snapshot })
        );

        expect(html).toContain('aria-label="Progress scope"');
        expect(html).toContain('Data coverage');
        expect(html).toContain('Connect a chess account');
        expect(html).toContain('href="/settings"');
        expect(html).toContain('No eligible Positions in this view');
        expect(html).toContain('No completed attempts yet');
    });

    it('renders first recorded outcomes before all-attempt diagnostics', () => {
        const snapshot = aggregateProgressSnapshot({
            request: {
                scope: 90,
                asOf: new Date('2026-07-30T00:00:00.000Z'),
                filters: { providers: [], timeClasses: [] },
            },
            user: {
                lichessUsername: 'player',
                chesscomUsername: null,
                serverCreditsBalance: 10,
            },
            games: [],
            positions: [],
            attempts: [],
        });
        snapshot.firstRecordedTerminalOutcome = {
            basis: 'FIRST_RECORDED_GRADED_OR_REVEALED_PER_POSITION',
            positions: 5,
            graded: 4,
            revealed: 1,
            metObjective: progressRate(2, 5),
            gradedFullSolve: progressRate(2, 4),
            gradeCounts: {
                BEST: 1,
                GOOD: 1,
                IMPROVED: 1,
                REPEATED_MISTAKE: 1,
                DIFFERENT_MISTAKE: 0,
            },
        };
        snapshot.practice = {
            ...snapshot.practice,
            gradedAttempts: 4,
            revealedAttempts: 1,
            fullPositionSolve: progressRate(2, 4),
            rootDecisionSuccess: progressRate(2, 4),
            exactOriginalMoveRepeated: progressRate(1, 4),
        };

        const html = renderToStaticMarkup(
            createElement(ProgressDashboard, { snapshot })
        );
        const firstOutcomeAt = html.indexOf('First recorded outcome');
        const allAttemptsAt = html.indexOf('Full Position solved');

        expect(firstOutcomeAt).toBeGreaterThan(-1);
        expect(allAttemptsAt).toBeGreaterThan(firstOutcomeAt);
        expect(html).toContain('Original move repeated');
        expect(html).toContain('Revealed');
    });

    it('keeps Practice-only breakdown rows and explains their time basis', () => {
        const snapshot = aggregateProgressSnapshot({
            request: {
                scope: 90,
                asOf: new Date('2026-07-30T00:00:00.000Z'),
                filters: { providers: [], timeClasses: [] },
            },
            user: {
                lichessUsername: 'player',
                chesscomUsername: null,
                serverCreditsBalance: 10,
            },
            games: [],
            positions: [],
            attempts: [],
        });
        snapshot.breakdowns.phase = [
            {
                key: 'MIDDLEGAME',
                positions: 0,
                sourceGames: 0,
                gradedAttempts: 1,
                fullPositionSolve: progressRate(1, 1),
            },
        ];

        const html = renderToStaticMarkup(
            createElement(ProgressDashboard, { snapshot })
        );

        expect(html).toContain('Middlegame');
        expect(html).toContain(
            'Positions from games played in scope'
        );
        expect(html).toContain('Graded attempts completed in scope');
        expect(html).toContain(
            'using context frozen when each attempt was recorded'
        );
    });

    it('shows unresolved completions without treating them as assessed outcomes', () => {
        const snapshot = aggregateProgressSnapshot({
            request: {
                scope: 90,
                asOf: new Date('2026-07-30T00:00:00.000Z'),
                filters: { providers: [], timeClasses: [] },
            },
            user: {
                lichessUsername: 'player',
                chesscomUsername: null,
                serverCreditsBalance: 10,
            },
            games: [],
            positions: [],
            attempts: [],
        });
        snapshot.practice.unresolvedExcluded = 2;

        const html = renderToStaticMarkup(
            createElement(ProgressDashboard, { snapshot })
        );

        expect(html).toContain('No assessable outcomes yet');
        expect(html).toContain('Unresolved');
        expect(html).not.toContain(
            'No completed attempts yet'
        );
        expect(html).toContain(
            'Positions with assessed outcome'
        );
    });

    it('does not hide Practice evidence when no source game matches the game-time axis', () => {
        const snapshot = aggregateProgressSnapshot({
            request: {
                scope: 90,
                asOf: new Date('2026-07-30T00:00:00.000Z'),
                filters: { providers: [], timeClasses: [] },
            },
            user: {
                lichessUsername: 'player',
                chesscomUsername: null,
                serverCreditsBalance: 10,
            },
            games: [],
            positions: [],
            attempts: [],
        });
        snapshot.availability.filteredEmpty = true;
        snapshot.practice = {
            ...snapshot.practice,
            gradedAttempts: 1,
            fullPositionSolve: progressRate(1, 1),
            rootDecisionSuccess: progressRate(1, 1),
        };

        const html = renderToStaticMarkup(
            createElement(ProgressDashboard, { snapshot })
        );

        expect(html).toContain('From your games');
        expect(html).toContain('In Practice');
        expect(html).toContain('Full Position solved');
        expect(html).toContain('Breakdowns');
    });
});
