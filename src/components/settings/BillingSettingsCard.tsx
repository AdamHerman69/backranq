'use client';

import * as React from 'react';
import { CreditCard } from 'lucide-react';
import { toast } from 'sonner';
import type { BillingPresentation } from '@/lib/billing/presentation';
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { EXPECTED_OWNER_HEADER } from '@/lib/auth/ownerContract';

export type BillingSettings = {
    presentation: BillingPresentation;
    serverCreditsBalance: number;
    monthlyServerCreditsLimit: number;
    autoAnalysisMonthlyGameLimit: number;
    autoAnalysisDailyGameLimit: number;
    canOpenPortal: boolean;
    stripeConfigured: boolean;
    stripeMissing: string[];
};

type CheckoutResponse = {
    url?: string;
    error?: string;
};

export function BillingSettingsCard({
    billing,
    ownerId,
}: {
    billing: BillingSettings;
    ownerId: string;
}) {
    const [loading, setLoading] = React.useState<string | null>(null);

    async function redirectToCheckout(plan: 'PLUS' | 'PRO') {
        setLoading(plan);
        const id = toast.loading(`Opening ${plan} checkout...`);
        try {
            const res = await fetch('/api/stripe/checkout', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    [EXPECTED_OWNER_HEADER]: ownerId,
                },
                body: JSON.stringify({ plan }),
            });
            const json = (await res.json().catch(() => ({}))) as CheckoutResponse;
            if (!res.ok || !json.url) {
                throw new Error(json.error ?? 'Checkout failed');
            }
            window.location.href = json.url;
        } catch (error) {
            toast.error(
                error instanceof Error ? error.message : 'Checkout failed',
                { id }
            );
            setLoading(null);
        }
    }

    async function redirectToPortal() {
        setLoading('portal');
        const id = toast.loading('Opening billing portal...');
        try {
            const res = await fetch('/api/stripe/portal', {
                method: 'POST',
                headers: { [EXPECTED_OWNER_HEADER]: ownerId },
            });
            const json = (await res.json().catch(() => ({}))) as CheckoutResponse;
            if (!res.ok || !json.url) {
                throw new Error(json.error ?? 'Billing portal failed');
            }
            window.location.href = json.url;
        } catch (error) {
            toast.error(
                error instanceof Error
                    ? error.message
                    : 'Billing portal failed',
                { id }
            );
            setLoading(null);
        }
    }

    const disabled = !billing.stripeConfigured || loading !== null;
    const { access, checkoutBlocked, checkoutBlockedReason, paidSubscription } =
        billing.presentation;

    return (
        <Card>
            <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                    <CreditCard className="h-4 w-4" />
                    Billing
                </CardTitle>
                <CardDescription>
                    Server analysis credits power automatic analysis while your browser is closed.
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-2">
                    <BillingState
                        label="Access"
                        value={`${access.planLabel} — ${access.sourceLabel}`}
                        description="This is the plan currently providing your Backranq features and capacity."
                    />
                    <BillingState
                        label="Paid subscription"
                        value={
                            paidSubscription
                                ? `${paidSubscription.planLabel} — ${paidSubscription.statusLabel}`
                                : 'None'
                        }
                        description={
                            paidSubscription?.description ??
                            'No live paid Stripe subscription is attached to this account.'
                        }
                        tone={
                            paidSubscription?.actionRequired
                                ? 'destructive'
                                : 'default'
                        }
                    />
                </div>

                <div className="grid gap-3 sm:grid-cols-3">
                    <Metric
                        label="Credits"
                        value={`${billing.serverCreditsBalance}/${billing.monthlyServerCreditsLimit}`}
                    />
                    <Metric
                        label="Auto games/month"
                        value={String(billing.autoAnalysisMonthlyGameLimit)}
                    />
                    <Metric
                        label="Auto games/day"
                        value={String(billing.autoAnalysisDailyGameLimit)}
                    />
                </div>

                <div className="flex flex-wrap gap-2">
                    <Button
                        type="button"
                        onClick={() => void redirectToCheckout('PLUS')}
                        disabled={
                            disabled ||
                            checkoutBlocked ||
                            access.plan === 'PLUS'
                        }
                    >
                        Choose Plus
                    </Button>
                    <Button
                        type="button"
                        variant="outline"
                        onClick={() => void redirectToCheckout('PRO')}
                        disabled={
                            disabled ||
                            checkoutBlocked ||
                            access.plan === 'PRO'
                        }
                    >
                        Choose Pro
                    </Button>
                    <Button
                        type="button"
                        variant="ghost"
                        onClick={() => void redirectToPortal()}
                        disabled={disabled || !billing.canOpenPortal}
                    >
                        Manage billing
                    </Button>
                </div>

                <div className="space-y-1 text-sm text-muted-foreground">
                    {!billing.stripeConfigured ? (
                        <span className="block text-destructive">
                            Billing setup incomplete: {billing.stripeMissing.join(', ')}.
                        </span>
                    ) : null}
                    {paidSubscription?.continuesAlongsideAccess ? (
                        <span className="block font-medium text-foreground">
                            Your paid subscription continues while this access is
                            active. Use Manage billing to change or cancel it.
                        </span>
                    ) : checkoutBlockedReason === 'EXISTING_CONTRACT' ? (
                        <span className="block">
                            Use Manage billing to change or cancel your existing
                            paid subscription.
                        </span>
                    ) : checkoutBlockedReason === 'ELEVATED_ACCESS' ? (
                        <span className="block">
                            Paid checkout is disabled while this access is active.
                        </span>
                    ) : null}
                </div>
            </CardContent>
        </Card>
    );
}

function BillingState({
    label,
    value,
    description,
    tone = 'default',
}: {
    label: string;
    value: string;
    description: string;
    tone?: 'default' | 'destructive';
}) {
    return (
        <div className="rounded-md border p-3" aria-label={label}>
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {label}
            </div>
            <div
                className={`mt-1 text-sm font-semibold ${
                    tone === 'destructive' ? 'text-destructive' : ''
                }`}
            >
                {value}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
                {description}
            </div>
        </div>
    );
}

function Metric({ label, value }: { label: string; value: string }) {
    return (
        <div className="rounded-md border p-3">
            <div className="text-xs text-muted-foreground">{label}</div>
            <div className="mt-1 text-sm font-medium">{value}</div>
        </div>
    );
}
