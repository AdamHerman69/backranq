'use client';

import { signOut } from 'next-auth/react';
import type { ReactNode } from 'react';

type Props = {
    callbackUrl?: string;
    children?: ReactNode;
};

export function SignOutButton({ callbackUrl = '/', children }: Props) {
    return (
        <button type="button" onClick={() => signOut({ callbackUrl })}>
            {children ?? 'Sign out'}
        </button>
    );
}

