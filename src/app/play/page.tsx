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
        <div className="space-y-6">
            <PageHeader
                title="Play with a coach"
                subtitle="Face a local chess opponent and pause on the decisions worth understanding."
            />
            <CoachOnlineShell ownerId={session.user.id} />
        </div>
    );
}
