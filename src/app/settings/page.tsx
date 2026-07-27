import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { ProfileForm, type UserProfile } from '@/components/settings/ProfileForm';
import { PageHeader } from '@/components/app/PageHeader';
import { Card, CardContent } from '@/components/ui/card';
import { AnalysisDefaultsCard } from '@/components/settings/AnalysisDefaultsCard';
import { AutoSyncSettingsCard } from '@/components/settings/AutoSyncSettingsCard';
import { BillingSettingsCard } from '@/components/settings/BillingSettingsCard';
import { TrainerSettingsCard } from '@/components/settings/TrainerSettingsCard';
import { getOrCreateDefaultBillingAccount } from '@/lib/services/billingAccounts';

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
            lichessUsername: true,
            chesscomUsername: true,
        },
    });
    if (!user) redirect('/login?callbackUrl=/settings');

    const initialUser: UserProfile = {
        id: user.id,
        email: user.email,
        name: user.name,
        image: user.image,
        lichessUsername: user.lichessUsername,
        chesscomUsername: user.chesscomUsername,
    };
    const billingAccount = await getOrCreateDefaultBillingAccount(userId);
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
        <div className="space-y-6">
            <PageHeader
                title="Settings"
                subtitle="Link your chess accounts so Backranq can import your games."
            />
            <Card>
                <CardContent className="pt-6">
                    <ProfileForm initialUser={initialUser} />
                </CardContent>
            </Card>
            <BillingSettingsCard
                billing={{
                    plan: billingAccount.plan,
                    serverCreditsBalance: billingAccount.serverCreditsBalance,
                    monthlyServerCreditsLimit:
                        billingAccount.monthlyServerCreditsLimit,
                    autoAnalysisMonthlyCap:
                        billingAccount.autoAnalysisMonthlyCap,
                    autoAnalysisDailyCap: billingAccount.autoAnalysisDailyCap,
                    stripeSubscriptionStatus:
                        billingAccount.stripeSubscriptionStatus,
                    stripeCurrentPeriodEnd:
                        billingAccount.stripeCurrentPeriodEnd?.toISOString() ??
                        null,
                    canOpenPortal: !!billingAccount.stripeCustomerId,
                    stripeConfigured: stripeMissing.length === 0,
                    stripeMissing,
                }}
            />
            <AutoSyncSettingsCard />
            <TrainerSettingsCard />
            <AnalysisDefaultsCard />
        </div>
    );
}
