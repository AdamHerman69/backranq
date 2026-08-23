import type { ReactNode } from 'react';

import { AppShell } from '@/components/app/AppShell';
import { SessionProvider } from '@/components/auth/SessionProvider';
import { SonnerToaster } from '@/components/ui/SonnerToaster';
import { getRequestSession } from '@/lib/auth/requestSession';

export default async function AuthenticatedAppLayout({
    children,
}: Readonly<{ children: ReactNode }>) {
    // Each page retains its route-specific redirect so callback URLs keep their
    // full filters/deep links. This read is shared with those guards by React's
    // request-local cache.
    const session = await getRequestSession();

    return (
        <SessionProvider initialSession={session}>
            <AppShell>{children}</AppShell>
            <SonnerToaster />
        </SessionProvider>
    );
}
