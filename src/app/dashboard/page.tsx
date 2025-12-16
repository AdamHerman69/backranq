import { getCurrentUser } from '@/lib/auth/session';
import { SignOutButton } from '@/components/auth/SignOutButton';

export default async function DashboardPage() {
    const user = await getCurrentUser();

    return (
        <main style={{ padding: 24 }}>
            <h1>Dashboard</h1>
            <p>
                Signed in as <strong>{user?.email ?? user?.name ?? 'Unknown'}</strong>
            </p>
            <div style={{ marginTop: 16 }}>
                <SignOutButton>Sign out</SignOutButton>
            </div>
        </main>
    );
}

