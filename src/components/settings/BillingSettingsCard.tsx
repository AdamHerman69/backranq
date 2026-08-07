'use client';

import * as React from 'react';
import { ArrowUpRight, CreditCard, Settings2 } from 'lucide-react';
import { toast } from 'sonner';
import type { BillingPresentation } from '@/lib/billing/presentation';
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from '@/components/ui/card';
import { InlineStatus } from '@/components/ui/async-state';
import { Badge } from '@/components/ui/badge';
import { LoadingButton } from '@/components/ui/loading-button';
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
        <Card variant="panel" className="overflow-hidden">
            <CardHeader className="gap-3 border-b border-border/70 bg-surface-subtle/50 sm:flex-row sm:items-start sm:justify-between sm:space-y-0">
                <div className="space-y-1.5">
                    <CardTitle className="flex items-center gap-2 text-base">
                        <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-primary/10 text-primary">
                            <CreditCard className="h-4 w-4" aria-hidden="true" />
                        </span>
                        Plan & analysis capacity
                    </CardTitle>
                    <CardDescription>
                        Server credits power automatic analysis while your browser is closed.
                    </CardDescription>
                </div>
                <Badge variant="outline" className="w-fit border-primary/20 bg-primary/10 text-primary">
                    {access.planLabel}
                </Badge>
            </CardHeader>
            <CardContent className="space-y-5 pt-5">
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
                        progress={
                            billing.monthlyServerCreditsLimit > 0
                                ? billing.serverCreditsBalance /
                                  billing.monthlyServerCreditsLimit
                                : 0
                        }
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

                <div className="flex flex-col gap-2 border-t border-border/70 pt-4 sm:flex-row sm:flex-wrap">
                    <LoadingButton
                        type="button"
                        className="sm:w-auto"
                        loading={loading === 'PLUS'}
                        loadingLabel="Opening Plus…"
                        onClick={() => void redirectToCheckout('PLUS')}
                        disabled={
                            disabled ||
                            checkoutBlocked ||
                            access.plan === 'PLUS'
                        }
                    >
                        <ArrowUpRight aria-hidden="true" />
                        Choose Plus
                    </LoadingButton>
                    <LoadingButton
                        type="button"
                        variant="outline"
                        className="sm:w-auto"
                        loading={loading === 'PRO'}
                        loadingLabel="Opening Pro…"
                        onClick={() => void redirectToCheckout('PRO')}
                        disabled={
                            disabled ||
                            checkoutBlocked ||
                            access.plan === 'PRO'
                        }
                    >
                        <ArrowUpRight aria-hidden="true" />
                        Choose Pro
                    </LoadingButton>
                    <LoadingButton
                        type="button"
                        variant="ghost"
                        className="sm:ml-auto sm:w-auto"
                        loading={loading === 'portal'}
                        loadingLabel="Opening billing…"
                        onClick={() => void redirectToPortal()}
                        disabled={disabled || !billing.canOpenPortal}
                    >
                        <Settings2 aria-hidden="true" />
                        Manage billing
                    </LoadingButton>
                </div>

                <div className="space-y-2 text-sm text-muted-foreground">
                    {!billing.stripeConfigured ? (
                        <InlineStatus tone="danger">
                            Plan changes are temporarily unavailable. Your current
                            access and credits are unaffected.
                        </InlineStatus>
                    ) : null}
                    {paidSubscription?.continuesAlongsideAccess ? (
                        <InlineStatus tone="warning">
                            Your paid subscription continues while this access is
                            active. Use Manage billing to change or cancel it.
                        </InlineStatus>
                    ) : checkoutBlockedReason === 'EXISTING_CONTRACT' ? (
                        <InlineStatus tone="info">
                            Use Manage billing to change or cancel your existing
                            paid subscription.
                        </InlineStatus>
                    ) : checkoutBlockedReason === 'ELEVATED_ACCESS' ? (
                        <InlineStatus tone="neutral">
                            Paid checkout is disabled while this access is active.
                        </InlineStatus>
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
        <div className="rounded-lg border border-border/70 bg-surface-subtle/45 p-3" aria-label={label}>
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

function Metric({
    label,
    value,
    progress,
}: {
    label: string;
    value: string;
    progress?: number;
}) {
    return (
        <div className="rounded-lg border border-border/70 bg-card p-3 shadow-control">
            <div className="text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground">
                {label}
            </div>
            <div className="mt-1 text-lg font-semibold tracking-[-0.025em]">{value}</div>
            {typeof progress === 'number' ? (
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-inset">
                    <div
                        className="h-full rounded-full bg-primary transition-[width] duration-slow ease-standard"
                        style={{ width: `${Math.max(0, Math.min(1, progress)) * 100}%` }}
                    />
                </div>
            ) : null}
        </div>
    );
}
