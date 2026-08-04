'use client';

import * as React from 'react';
import { CreditCard } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

type BillingSettings = {
    plan: string;
    serverCreditsBalance: number;
    monthlyServerCreditsLimit: number;
    autoAnalysisMonthlyGameLimit: number;
    autoAnalysisDailyGameLimit: number;
    stripeSubscriptionStatus: string | null;
    stripeCurrentPeriodEnd: string | null;
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
}: {
    billing: BillingSettings;
}) {
    const [loading, setLoading] = React.useState<string | null>(null);

    async function redirectToCheckout(plan: 'PLUS' | 'PRO') {
        setLoading(plan);
        const id = toast.loading(`Opening ${plan} checkout...`);
        try {
            const res = await fetch('/api/stripe/checkout', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
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
            const res = await fetch('/api/stripe/portal', { method: 'POST' });
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
    const periodEnd = billing.stripeCurrentPeriodEnd
        ? new Date(billing.stripeCurrentPeriodEnd).toLocaleDateString()
        : null;

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
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <Metric label="Plan" value={billing.plan} />
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
                        disabled={disabled || billing.plan === 'PLUS'}
                    >
                        Choose Plus
                    </Button>
                    <Button
                        type="button"
                        variant="outline"
                        onClick={() => void redirectToCheckout('PRO')}
                        disabled={disabled || billing.plan === 'PRO'}
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

                <div className="text-sm text-muted-foreground">
                    Status: {billing.stripeSubscriptionStatus ?? 'free'}
                    {periodEnd ? `, renews ${periodEnd}` : ''}
                    {!billing.stripeConfigured ? (
                        <span className="block text-destructive">
                            Billing setup incomplete: {billing.stripeMissing.join(', ')}.
                        </span>
                    ) : null}
                </div>
            </CardContent>
        </Card>
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
