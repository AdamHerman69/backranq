import type {
    BillingAccount,
    BillingPlan,
    BillingPlanSource,
    Prisma,
} from '@prisma/client';
import { billingPlanRank } from '@/lib/billing/plans';
import { stripeSubscriptionProvidesAccess } from '@/lib/billing/stripeContract';

type EntitlementClient = Pick<
    Prisma.TransactionClient,
    'adminMembership' | 'planGrant'
>;

export type EffectiveBillingEntitlement = {
    plan: BillingPlan;
    source: BillingPlanSource;
    grantId: string | null;
};

const SOURCE_PRIORITY: Record<BillingPlanSource, number> = {
    FREE: 0,
    STRIPE: 1,
    COMPLIMENTARY: 2,
    ADMIN: 3,
};

export async function resolveEffectiveBillingEntitlement(args: {
    tx: EntitlementClient;
    userId: string;
    account: Pick<
        BillingAccount,
        'stripePlan' | 'stripeSubscriptionStatus'
    >;
    now: Date;
}): Promise<EffectiveBillingEntitlement> {
    const [adminMembership, grants] = await Promise.all([
        args.tx.adminMembership.findUnique({
            where: { userId: args.userId },
            select: { active: true },
        }),
        args.tx.planGrant.findMany({
            where: {
                userId: args.userId,
                revokedAt: null,
                startsAt: { lte: args.now },
                OR: [{ expiresAt: null }, { expiresAt: { gt: args.now } }],
            },
            select: { id: true, plan: true },
            orderBy: { createdAt: 'desc' },
        }),
    ]);

    const candidates: EffectiveBillingEntitlement[] = [
        { plan: 'FREE', source: 'FREE', grantId: null },
    ];
    if (
        args.account.stripePlan != null &&
        args.account.stripePlan !== 'FREE' &&
        stripeSubscriptionProvidesAccess(args.account.stripeSubscriptionStatus)
    ) {
        candidates.push({
            plan: args.account.stripePlan,
            source: 'STRIPE',
            grantId: null,
        });
    }
    for (const grant of grants ?? []) {
        if (grant.plan === 'FREE') continue;
        candidates.push({
            plan: grant.plan,
            source: 'COMPLIMENTARY',
            grantId: grant.id,
        });
    }
    if (adminMembership?.active) {
        candidates.push({ plan: 'PRO', source: 'ADMIN', grantId: null });
    }

    return candidates.sort((left, right) => {
        const planDifference =
            billingPlanRank(right.plan) - billingPlanRank(left.plan);
        if (planDifference !== 0) return planDifference;
        return SOURCE_PRIORITY[right.source] - SOURCE_PRIORITY[left.source];
    })[0]!;
}
