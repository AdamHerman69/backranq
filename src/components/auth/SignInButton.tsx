'use client';

import { signIn } from 'next-auth/react';
import type { ReactNode } from 'react';

type Props = {
    provider?: 'google' | 'github';
    callbackUrl?: string;
    children?: ReactNode;
};

export function SignInButton({
    provider = 'google',
    callbackUrl = '/dashboard',
    children,
}: Props) {
    return (
        <button
            type="button"
            onClick={() => signIn(provider, { callbackUrl })}
        >
            {children ?? `Sign in with ${provider}`}
        </button>
    );
}

