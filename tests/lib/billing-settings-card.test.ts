import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next-auth/react', () => ({
    useSession: () => ({ data: null, status: 'loading' }),
}));

import {
    BillingSettingsCard,
    type BillingSettings,
} from '@/components/settings/BillingSettingsCard';
import { presentBillingAccount } from '@/lib/billing/presentation';

describe('billing settings card', () => {
    it('renders effective access and a simultaneous paid subscription explicitly', () => {
        const html = renderBilling({
            presentation: presentBillingAccount({
                plan: 'PRO',
                planSource: 'ADMIN',
                stripePlan: 'PLUS',
                stripeSubscriptionStatus: 'active',
                stripeCurrentPeriodEnd: '2027-01-15T08:00:00.000Z',
            }),
        });

        expect(html).toContain('aria-label="Access"');
        expect(html).toContain('Pro — Administrator access');
        expect(html).toContain('aria-label="Paid subscription"');
        expect(html).toContain('Plus — Active');
        expect(html).toContain('Current period ends Jan 15, 2027.');
        expect(html).toContain(
            'Your paid subscription continues while this access is active.'
        );
        expect(html).toContain('Manage billing');
    });

    it('does not invent a paid subscription for complimentary access', () => {
        const html = renderBilling({
            presentation: presentBillingAccount({
                plan: 'PRO',
                planSource: 'COMPLIMENTARY',
                stripePlan: 'FREE',
                stripeSubscriptionStatus: null,
                stripeCurrentPeriodEnd: null,
            }),
        });

        expect(html).toContain('Pro — Complimentary access');
        expect(html).toContain('Paid subscription');
        expect(html).toContain('>None<');
        expect(html).toContain(
            'Paid checkout is disabled while this access is active.'
        );
    });

    it('keeps a past-due contract visible as requiring action', () => {
        const html = renderBilling({
            presentation: presentBillingAccount({
                plan: 'FREE',
                planSource: 'FREE',
                stripePlan: 'PLUS',
                stripeSubscriptionStatus: 'past_due',
                stripeCurrentPeriodEnd: '2027-01-15T08:00:00.000Z',
            }),
        });

        expect(html).toContain('Plus — Payment past due');
        expect(html).toContain('text-destructive');
        expect(html).toContain(
            'Open the billing portal to resolve the subscription.'
        );
        expect(html).toContain(
            'Use Manage billing to change or cancel your existing paid subscription.'
        );
    });
});

function renderBilling(overrides: Partial<BillingSettings> = {}) {
    const billing: BillingSettings = {
        presentation: presentBillingAccount({
            plan: 'FREE',
            planSource: 'FREE',
            stripePlan: 'FREE',
            stripeSubscriptionStatus: null,
            stripeCurrentPeriodEnd: null,
        }),
        serverCreditsBalance: 100,
        monthlyServerCreditsLimit: 100,
        autoAnalysisMonthlyGameLimit: 50,
        autoAnalysisDailyGameLimit: 10,
        canOpenPortal: true,
        stripeConfigured: true,
        stripeMissing: [],
        ...overrides,
    };

    return renderToStaticMarkup(
        createElement(BillingSettingsCard, { billing, ownerId: 'user-1' })
    );
}
