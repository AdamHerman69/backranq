import { redirect } from 'next/navigation';

import { HomeDashboard } from './HomeDashboard';
import { getRequestSession } from '@/lib/auth/requestSession';
import { readHomeDashboardSnapshot } from '@/lib/home/readService';

export default async function HomePage() {
    const session = await getRequestSession();
    if (!session?.user?.id) {
        redirect('/login?callbackUrl=/home');
    }

    const snapshot = await readHomeDashboardSnapshot(session.user.id);
    return (
        <HomeDashboard
            viewer={{
                id: session.user.id,
                name: session.user.name ?? null,
            }}
            snapshot={snapshot}
        />
    );
}
