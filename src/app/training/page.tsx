import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { TrainingTrainer } from '@/components/training/TrainingTrainer';

export default async function TrainingPage({
    searchParams,
}: {
    searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) redirect('/login?callbackUrl=/training');

    const sp = (await searchParams) ?? {};
    const momentId =
        typeof sp.momentId === 'string' ? sp.momentId.trim() : undefined;

    return (
        <TrainingTrainer
            initialMomentId={momentId || undefined}
            ownerId={userId}
        />
    );
}
