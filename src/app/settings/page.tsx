import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { AppNav } from '@/components/nav/AppNav';
import { ProfileForm, type UserProfile } from '@/components/settings/ProfileForm';
import styles from './page.module.css';

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

    return (
        <div className={styles.page}>
            <main className={styles.main}>
                <AppNav />
                <header className={styles.header}>
                    <h1>Settings</h1>
                    <p>Link your chess accounts so BackRank can import your games.</p>
                </header>
                <section className={styles.panel}>
                    <ProfileForm initialUser={initialUser} />
                </section>
            </main>
        </div>
    );
}


