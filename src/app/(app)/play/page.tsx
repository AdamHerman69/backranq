import { redirect } from 'next/navigation';

import { PageHeader } from '@/components/app/PageHeader';
import { CoachOnlineShell } from '@/components/coach/CoachOnlineShell';
import { getRequestSession } from '@/lib/auth/requestSession';

export default async function PlayPage() {
    const session = await getRequestSession();
    if (!session?.user?.id) {
        redirect('/login?callbackUrl=%2Fplay');
    }

    return (
        <div className="space-y-3 sm:space-y-5">
            <PageHeader
                title="Play with a coach"
                subtitle="Play a full game and pause only when a decision is worth understanding."
                subtitleClassName="hidden sm:block"
            />
            <CoachOnlineShell ownerId={session.user.id} />
        </div>
    );
}
