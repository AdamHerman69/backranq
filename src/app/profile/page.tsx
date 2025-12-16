import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { SignOutButton } from '@/components/auth/SignOutButton';
import Link from 'next/link';

export default async function ProfilePage() {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) redirect('/login?callbackUrl=/profile');

    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
            email: true,
            name: true,
            image: true,
            lichessUsername: true,
            chesscomUsername: true,
        },
    });

    return (
        <main style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <h1>Profile</h1>
            <div style={{ fontSize: 13, opacity: 0.85 }}>
                <div>
                    <strong>Email:</strong> {user?.email ?? '—'}
                </div>
                <div>
                    <strong>Name:</strong> {user?.name ?? '—'}
                </div>
                <div>
                    <strong>Lichess:</strong> {user?.lichessUsername ?? '—'}
                </div>
                <div>
                    <strong>Chess.com:</strong> {user?.chesscomUsername ?? '—'}
                </div>
            </div>

            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                <Link href="/settings">Edit settings</Link>
                <Link href="/games">Your games</Link>
                <SignOutButton>Sign out</SignOutButton>
            </div>
        </main>
    );
}


