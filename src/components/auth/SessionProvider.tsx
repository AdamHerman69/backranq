'use client';

import { SessionProvider as NextAuthSessionProvider } from 'next-auth/react';
import type { Session } from 'next-auth';
import type { ReactNode } from 'react';

export function SessionProvider({
    children,
    initialSession,
}: {
    children: ReactNode;
    initialSession: Session | null;
}) {
    return (
        <NextAuthSessionProvider session={initialSession}>
            {children}
        </NextAuthSessionProvider>
    );
}
