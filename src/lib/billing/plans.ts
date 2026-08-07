import type { BillingPlan } from '@prisma/client';

export type BillingPlanEntitlements = {
    plan: BillingPlan;
    monthlyServerCreditsLimit: number;
    autoAnalysisMonthlyGameLimit: number;
    autoAnalysisDailyGameLimit: number;
    stopWhenCreditsBelow: number;
};

export const BILLING_PLAN_ENTITLEMENTS = {
    FREE: {
        plan: 'FREE',
        monthlyServerCreditsLimit: 100,
        autoAnalysisMonthlyGameLimit: 50,
        autoAnalysisDailyGameLimit: 10,
        stopWhenCreditsBelow: 0,
    },
    PLUS: {
        plan: 'PLUS',
        monthlyServerCreditsLimit: 1_000,
        autoAnalysisMonthlyGameLimit: 500,
        autoAnalysisDailyGameLimit: 50,
        stopWhenCreditsBelow: 0,
    },
    PRO: {
        plan: 'PRO',
        monthlyServerCreditsLimit: 5_000,
        autoAnalysisMonthlyGameLimit: 5_000,
        autoAnalysisDailyGameLimit: 250,
        stopWhenCreditsBelow: 0,
    },
} as const satisfies Record<BillingPlan, BillingPlanEntitlements>;

export function billingPlanRank(plan: BillingPlan) {
    return plan === 'PRO' ? 2 : plan === 'PLUS' ? 1 : 0;
}
