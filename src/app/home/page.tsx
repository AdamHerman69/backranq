import { redirect } from 'next/navigation';

import { HomeDashboard } from '@/app/home/HomeDashboard';
import { auth } from '@/lib/auth';

export default async function HomePage() {
    const session = await auth();
    if (!session?.user?.id) {
        redirect('/login?callbackUrl=/home');
    }

    return <HomeDashboard />;
}
