import { redirect } from 'next/navigation';

import { PageHeader } from '@/components/app/PageHeader';
import { CoachGame } from '@/components/coach/CoachGame';
import { CoachOfflineRegistration } from '@/components/coach/CoachOfflineRegistration';
import { auth } from '@/lib/auth';

export default async function PlayPage() {
    const session = await auth();
    if (!session?.user?.id) {
        redirect('/login?callbackUrl=%2Fplay');
    }

    return (
        <div className="space-y-6">
            <PageHeader
                title="Play with a coach"
                subtitle="Face a local chess opponent and pause on the decisions worth understanding."
            />
            <CoachOfflineRegistration />
            <CoachGame ownerId={session.user.id} />
        </div>
    );
}
