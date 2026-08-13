import type { ReactNode } from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
    Bell,
    ChevronRight,
    CreditCard,
    SlidersHorizontal,
    Sparkles,
    Unplug,
    UserRound,
} from 'lucide-react';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { ProfileForm, type UserProfile } from '@/components/settings/ProfileForm';
import { PageHeader } from '@/components/app/PageHeader';
import { AnalysisDefaultsCard } from '@/components/settings/AnalysisDefaultsCard';
import { GameAutomationSettingsCard } from '@/components/settings/AutoSyncSettingsCard';
import { BillingSettingsCard } from '@/components/settings/BillingSettingsCard';
import { getOrCreateDefaultBillingAccount } from '@/lib/services/billingAccounts';
import { PracticeDefaultsCard } from '@/components/settings/PracticeDefaultsCard';
import { NotificationSettingsCard } from '@/components/settings/NotificationSettingsCard';
import { presentBillingAccount } from '@/lib/billing/presentation';
import {
    chessAccountConnectionSelect,
    linkedUsernameSnapshot,
} from '@/lib/accounts/chessAccountConnections';
import { Button } from '@/components/ui/button';
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from '@/components/ui/card';

const SETTINGS_LINKS = [
    { href: '#connections', label: 'Connections', icon: Unplug },
    { href: '#game-automation', label: 'Automation', icon: Sparkles },
    { href: '#training', label: 'Training', icon: SlidersHorizontal },
    { href: '#notifications', label: 'Notifications', icon: Bell },
    { href: '#billing', label: 'Plan & account', icon: CreditCard },
] as const;

export default async function SettingsPage() {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) redirect('/login?callbackUrl=/settings');

    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
            id: true,
            email: true,
            name: true,
            image: true,
            chessAccountConnections: {
                select: chessAccountConnectionSelect,
            },
        },
    });
    if (!user) redirect('/login?callbackUrl=/settings');

    const initialUser: UserProfile = {
        id: user.id,
        email: user.email,
        name: user.name,
        image: user.image,
        ...linkedUsernameSnapshot(user.chessAccountConnections),
    };
    const billingAccount = await getOrCreateDefaultBillingAccount(userId);
    const billingPresentation = presentBillingAccount({
        plan: billingAccount.plan,
        planSource: billingAccount.planSource,
        stripePlan: billingAccount.stripePlan,
        stripeSubscriptionStatus: billingAccount.stripeSubscriptionStatus,
        stripeCurrentPeriodEnd:
            billingAccount.stripeCurrentPeriodEnd?.toISOString() ?? null,
    });
    const stripeMissing = [
        !process.env.STRIPE_SECRET_KEY ? 'STRIPE_SECRET_KEY' : null,
        !process.env.STRIPE_WEBHOOK_SECRET ? 'STRIPE_WEBHOOK_SECRET' : null,
        !process.env.STRIPE_PRICE_PLUS_MONTHLY
            ? 'STRIPE_PRICE_PLUS_MONTHLY'
            : null,
        !process.env.STRIPE_PRICE_PRO_MONTHLY
            ? 'STRIPE_PRICE_PRO_MONTHLY'
            : null,
        !(
            process.env.BACKRANQ_APP_URL ||
            process.env.NEXTAUTH_URL ||
            process.env.VERCEL_PROJECT_PRODUCTION_URL
        )
            ? 'BACKRANQ_APP_URL or NEXTAUTH_URL'
            : null,
    ].filter((item): item is string => Boolean(item));

    return (
        <div className="space-y-7 sm:space-y-10">
            <PageHeader
                eyebrow="Account"
                title="Settings"
                subtitle="Connect your chess life, decide what runs automatically, and shape how Backranq trains you."
                actions={
                    <Button asChild variant="outline" size="sm">
                        <Link href="/profile">
                            <UserRound aria-hidden="true" />
                            Profile
                        </Link>
                    </Button>
                }
            />

            <nav
                aria-label="Settings sections"
                className="w-full pb-1"
            >
                <div className="grid grid-cols-3 border-b border-foreground/10 sm:flex sm:flex-wrap">
                    {SETTINGS_LINKS.map(({ href, label, icon: Icon }) => (
                        <Link
                            key={href}
                            href={href}
                            className="group inline-flex min-h-11 min-w-0 items-center justify-center gap-1.5 border-b-2 border-transparent px-2 text-[0.72rem] font-medium text-muted-foreground transition-[color,border-color,background-color] duration-fast ease-standard hover:border-primary hover:bg-primary/[0.04] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset sm:min-h-10 sm:justify-start sm:gap-2 sm:px-3.5 sm:text-sm"
                        >
                            <Icon className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
                            {label}
                        </Link>
                    ))}
                </div>
            </nav>

            <SettingsSection
                id="connections"
                index="01"
                title="Chess sources"
                description="Link the profiles Backranq should watch, then choose exactly what happens when new games arrive."
            >
                <div className="space-y-4">
                    <ProfileForm initialUser={initialUser} />
                    <GameAutomationSettingsCard ownerId={initialUser.id} />
                </div>
            </SettingsSection>

            <SettingsSection
                id="training"
                index="02"
                title="Training preferences"
                description="Set the defaults you want every practice and analysis session to start with."
            >
                <div className="grid gap-4 xl:grid-cols-2 xl:items-start">
                    <PracticeDefaultsCard ownerId={initialUser.id} />
                    <AnalysisDefaultsCard ownerId={initialUser.id} />
                </div>
            </SettingsSection>

            <SettingsSection
                id="notifications"
                index="03"
                title="Notifications"
                description="Keep only the updates that help you return at the right moment."
            >
                <NotificationSettingsCard ownerId={initialUser.id} />
            </SettingsSection>

            <SettingsSection
                id="plan-account"
                index="04"
                title="Plan & account"
                description="Review capacity and billing first. Session and identity controls stay deliberately separate."
            >
                <div className="space-y-4">
                    <section id="billing" className="scroll-mt-24">
                        <BillingSettingsCard
                            ownerId={initialUser.id}
                            billing={{
                                presentation: billingPresentation,
                                serverCreditsBalance:
                                    billingAccount.serverCreditsBalance,
                                monthlyServerCreditsLimit:
                                    billingAccount.monthlyServerCreditsLimit,
                                autoAnalysisMonthlyGameLimit:
                                    billingAccount.autoAnalysisMonthlyGameLimit,
                                autoAnalysisDailyGameLimit:
                                    billingAccount.autoAnalysisDailyGameLimit,
                                canOpenPortal: !!billingAccount.stripeCustomerId,
                                stripeConfigured: stripeMissing.length === 0,
                                stripeMissing,
                            }}
                        />
                    </section>
                    <Card variant="subtle">
                        <CardHeader className="sm:flex-row sm:items-start sm:justify-between sm:space-y-0">
                            <div className="space-y-1.5">
                                <CardTitle className="text-base">Backranq account</CardTitle>
                                <CardDescription>
                                    {initialUser.name || 'Your account'}
                                    {initialUser.email ? ` · ${initialUser.email}` : ''}
                                </CardDescription>
                            </div>
                            <Button asChild variant="outline" size="sm">
                                <Link href="/profile">
                                    Account controls
                                    <ChevronRight aria-hidden="true" />
                                </Link>
                            </Button>
                        </CardHeader>
                        <CardContent className="text-xs leading-relaxed text-muted-foreground">
                            Sign-out and identity details live on your profile, away from everyday training controls.
                        </CardContent>
                    </Card>
                </div>
            </SettingsSection>
        </div>
    );
}

function SettingsSection({
    id,
    index,
    title,
    description,
    children,
}: {
    id?: string;
    index: string;
    title: string;
    description: string;
    children: ReactNode;
}) {
    return (
        <section
            id={id}
            className="scroll-mt-24 border-t border-foreground/10 pt-6 sm:pt-8"
            aria-labelledby={`settings-section-${index}`}
        >
            <div className="grid gap-4 lg:grid-cols-[12rem_minmax(0,1fr)] lg:gap-8 xl:grid-cols-[14rem_minmax(0,1fr)]">
                <div className="lg:pt-1">
                    <div className="flex items-baseline gap-2 lg:block">
                        <span className="font-mono text-[10px] font-semibold tracking-[0.18em] text-primary/70">
                            {index}
                        </span>
                        <h2
                            id={`settings-section-${index}`}
                            className="font-display text-xl font-semibold tracking-[-0.02em] text-foreground lg:mt-2 lg:text-2xl"
                        >
                            {title}
                        </h2>
                    </div>
                    <p className="mt-1 max-w-xl text-sm leading-relaxed text-muted-foreground lg:mt-2">
                        {description}
                    </p>
                </div>
                <div className="min-w-0">{children}</div>
            </div>
        </section>
    );
}
