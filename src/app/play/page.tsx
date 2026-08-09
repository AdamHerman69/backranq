import { redirect } from 'next/navigation';

import { PageHeader } from '@/components/app/PageHeader';
import { CoachOnlineShell } from '@/components/coach/CoachOnlineShell';
import { auth } from '@/lib/auth';

export default async function PlayPage() {
    const session = await auth();
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
