import type { BillingPlan, BillingPlanSource } from '@prisma/client';

import { hasLiveStripeContract } from '@/lib/billing/stripeContract';

export type BillingPresentation = {
    access: {
        plan: BillingPlan;
        planLabel: string;
        source: BillingPlanSource;
        sourceLabel: string;
    };
    paidSubscription: {
        plan: Exclude<BillingPlan, 'FREE'> | null;
        planLabel: string;
        status: string;
        statusLabel: string;
        periodEndLabel: string | null;
        description: string;
        actionRequired: boolean;
        continuesAlongsideAccess: boolean;
    } | null;
    checkoutBlocked: boolean;
    checkoutBlockedReason: 'ELEVATED_ACCESS' | 'EXISTING_CONTRACT' | null;
};

type BillingPresentationInput = {
    plan: BillingPlan;
    planSource: BillingPlanSource;
    stripePlan: BillingPlan;
    stripeSubscriptionStatus: string | null;
    stripeCurrentPeriodEnd: string | null;
};

const ELEVATED_ACCESS_SOURCES = new Set<BillingPlanSource>([
    'ADMIN',
    'COMPLIMENTARY',
]);

const ACTION_REQUIRED_STATUSES = new Set([
    'incomplete',
    'past_due',
    'unpaid',
]);

const STATUS_LABELS: Record<string, string> = {
    active: 'Active',
    incomplete: 'Setup incomplete',
    past_due: 'Payment past due',
    paused: 'Paused',
    trialing: 'Trialing',
    unpaid: 'Unpaid',
};

const SOURCE_LABELS: Record<BillingPlanSource, string> = {
    FREE: 'Free access',
    STRIPE: 'Paid subscription',
    ADMIN: 'Administrator access',
    COMPLIMENTARY: 'Complimentary access',
};

export function presentBillingAccount(
    input: BillingPresentationInput
): BillingPresentation {
    const elevatedAccess = ELEVATED_ACCESS_SOURCES.has(input.planSource);
    const status = input.stripeSubscriptionStatus;
    const liveContract = hasLiveStripeContract(status);
    const paidSubscription = liveContract && status
        ? paidSubscriptionPresentation({
              ...input,
              elevatedAccess,
              status,
          })
        : null;

    return {
        access: {
            plan: input.plan,
            planLabel: planLabel(input.plan),
            source: input.planSource,
            sourceLabel: SOURCE_LABELS[input.planSource],
        },
        paidSubscription,
        checkoutBlocked: elevatedAccess || liveContract,
        checkoutBlockedReason: liveContract
            ? 'EXISTING_CONTRACT'
            : elevatedAccess
              ? 'ELEVATED_ACCESS'
              : null,
    };
}

function paidSubscriptionPresentation(
    input: BillingPresentationInput & {
        elevatedAccess: boolean;
        status: string;
    }
): NonNullable<BillingPresentation['paidSubscription']> {
    const periodEndLabel = formatPeriodEnd(input.stripeCurrentPeriodEnd);
    const actionRequired = ACTION_REQUIRED_STATUSES.has(input.status);
    const description = actionRequired
        ? 'Open the billing portal to resolve the subscription.'
        : periodEndLabel &&
            (input.status === 'active' || input.status === 'trialing')
          ? `Current period ends ${periodEndLabel}.`
          : 'Use the billing portal to manage this subscription.';

    return {
        plan: input.stripePlan === 'FREE' ? null : input.stripePlan,
        planLabel:
            input.stripePlan === 'FREE'
                ? 'Paid subscription'
                : planLabel(input.stripePlan),
        status: input.status,
        statusLabel:
            STATUS_LABELS[input.status] ?? humanizeStatus(input.status),
        periodEndLabel,
        description,
        actionRequired,
        continuesAlongsideAccess: input.elevatedAccess,
    };
}

function planLabel(plan: BillingPlan) {
    return plan === 'FREE' ? 'Free' : plan === 'PLUS' ? 'Plus' : 'Pro';
}

function humanizeStatus(status: string) {
    return status
        .split('_')
        .filter(Boolean)
        .map((part) => part[0]!.toUpperCase() + part.slice(1))
        .join(' ');
}

function formatPeriodEnd(periodEnd: string | null) {
    if (!periodEnd) return null;
    const parsed = new Date(periodEnd);
    if (Number.isNaN(parsed.getTime())) return null;
    return new Intl.DateTimeFormat('en-US', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC',
    }).format(parsed);
}
