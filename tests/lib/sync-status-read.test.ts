import { describe, expect, it, vi } from 'vitest';

import {
    readSyncStatusSnapshot,
    syncStatusReadTestUtils,
} from '@/lib/services/syncStatusRead';
import { defaultPreferences, resolveAutoAnalysisPolicy } from '@/lib/preferences';

function billingAccount() {
    const periodStart = new Date('2026-08-01T00:00:00.000Z');
    return {
        id: 'billing-1',
        userId: '10000000-0000-4000-8000-000000000001',
        plan: 'FREE',
        planSource: 'FREE',
        stripePlan: 'FREE',
        stripeCustomerId: null,
        stripeSubscriptionId: null,
        stripeSubscriptionStatus: null,
        stripePriceId: null,
        stripeCurrentPeriodStart: null,
        stripeCurrentPeriodEnd: null,
        stripeLastEventCreatedAt: null,
        stripeLastEventId: null,
        stripeCheckoutReservationId: null,
        stripeCheckoutSessionId: null,
        stripeCheckoutPlan: null,
        stripeCheckoutExpiresAt: null,
        stripeCheckoutFencePlan: null,
        stripeCheckoutFenceSource: null,
        serverCreditsBalance: 100,
        monthlyServerCreditsUsed: 0,
        serverCreditsPeriodStart: periodStart,
        serverCreditsRenewAt: new Date('2026-09-01T00:00:00.000Z'),
        monthlyServerCreditsLimit: 100,
        autoAnalysisMonthlyGameLimit: 50,
        autoAnalysisDailyGameLimit: 10,
        stopWhenCreditsBelow: 0,
        createdAt: periodStart,
        updatedAt: periodStart,
    };
}

describe('compact sync status reader', () => {
    it('uses a typed empty predicate when no provider rule is eligible', () => {
        const policy = {
            ...resolveAutoAnalysisPolicy(defaultPreferences()),
            enabled: true,
        };

        expect(
            syncStatusReadTestUtils.candidateMetadataWhere(policy)
        ).toMatchObject({ OR: [{ id: { in: [] } }] });
    });

    it('keeps draws in the status predicate for the all-results policy', () => {
        const preferences = defaultPreferences();
        preferences.gameAutomation.rules.lichess.rapid = 'AUTO_ANALYZE';
        preferences.gameAutomation.analysis.resultScope = 'all';
        const policy = {
            ...resolveAutoAnalysisPolicy(preferences),
            enabled: true,
        };

        expect(
            syncStatusReadTestUtils.candidateMetadataWhere(policy).OR
        ).toContainEqual({
            provider: 'LICHESS',
            timeClass: { in: ['RAPID'] },
            result: '1/2-1/2',
        });
    });

    it('assembles the full snapshot within seven route-owned client operations', async () => {
        const calls: string[] = [];
        const operation = <T>(name: string, value: T) =>
            vi.fn(async () => {
                calls.push(name);
                return value;
            });
        const db = {
            user: {
                findUnique: operation('user', {
                    preferences: {
                        gameAutomation: {
                            rules: {
                                lichess: { rapid: 'AUTO_ANALYZE' },
                            },
                            analysis: {
                                existingGames: 'all',
                            },
                        },
                    },
                    chessAccountConnections: [],
                }),
            },
            providerSyncState: {
                findMany: operation('sync-states', []),
            },
            billingAccount: {
                findUnique: operation('billing-account', billingAccount()),
            },
            adminMembership: {
                findUnique: operation('admin-entitlement', null),
            },
            planGrant: {
                findMany: operation('plan-grants', []),
            },
            creditLedgerEntry: {
                groupBy: operation('billing-reconciliation-ledger', []),
            },
            $queryRaw: operation('status-metrics', [
                {
                    lichessLatest: null,
                    chesscomLatest: null,
                    totalImported: 12,
                    analyzed: 5,
                    queued: 2,
                    running: 1,
                    failed: 0,
                    autoQueued: 1,
                    autoRunning: 1,
                    autoFailed: 0,
                    outstandingReserved: 20,
                    monthlyAutoGames: 3,
                    dailyAutoGames: 1,
                },
            ]),
            analyzedGame: {
                findMany: operation('status-candidates', []),
            },
        };

        const snapshot = await readSyncStatusSnapshot(
            '10000000-0000-4000-8000-000000000001',
            {
                now: new Date('2026-08-23T12:00:00.000Z'),
                db: db as never,
            }
        );

        expect(snapshot.inventory).toEqual({
            totalImported: 12,
            analyzed: 5,
            unanalyzed: 7,
        });
        expect(snapshot.analysisJobs).toEqual({
            queued: 2,
            running: 1,
            failed: 0,
        });
        expect(snapshot.billing?.outstandingReservations).toBe(20);
        expect(calls).toEqual(
            expect.arrayContaining([
                'user',
                'sync-states',
                'billing-account',
                'admin-entitlement',
                'plan-grants',
                'status-metrics',
                'status-candidates',
            ])
        );
        expect(calls).toHaveLength(7);
        expect(calls).not.toContain('billing-reconciliation-ledger');
    });
});
