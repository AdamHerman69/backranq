import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { safeAuthCallbackUrl } from '@/lib/auth/callbackUrl';
import { PageHeader } from '@/components/app/PageHeader';
import { TrainingTrainer } from '@/components/training/TrainingTrainer';
import { isTrainingApiUuid } from '@/lib/training/apiValidation';

export default async function PracticePage({
    searchParams,
}: {
    searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
    const sp = (await searchParams) ?? {};
    const rawMomentId =
        typeof sp.momentId === 'string' ? sp.momentId.trim() : undefined;
    const momentId =
        rawMomentId && isTrainingApiUuid(rawMomentId)
            ? rawMomentId
            : undefined;
    const practiceCallbackUrl = safeAuthCallbackUrl(
        momentId
            ? `/practice?${new URLSearchParams({ momentId }).toString()}`
            : '/practice',
        '/practice'
    );

    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) {
        const loginSearchParams = new URLSearchParams({
            callbackUrl: practiceCallbackUrl,
        });
        redirect(`/login?${loginSearchParams.toString()}`);
    }

    return (
        <div className="space-y-6">
            <PageHeader
                title="Practice"
                subtitle="Play the best move you can find, then review the position."
            />
            <TrainingTrainer
                initialMomentId={momentId}
                ownerId={userId}
            />
        </div>
    );
}
