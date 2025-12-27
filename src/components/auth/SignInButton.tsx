'use client';

import { signIn } from 'next-auth/react';
import type { ReactNode } from 'react';

import { Button, type ButtonProps } from '@/components/ui/button';

type Props = {
    provider?: string;
    callbackUrl?: string;
    children?: ReactNode;
    variant?: ButtonProps['variant'];
    size?: ButtonProps['size'];
    className?: string;
};

export function SignInButton({
    provider = 'google',
    callbackUrl = '/',
    children,
    variant = 'default',
    size = 'default',
    className,
}: Props) {
    return (
        <Button
            type="button"
            onClick={() => signIn(provider, { callbackUrl })}
            variant={variant}
            size={size}
            className={className}
        >
            {children ?? `Sign in with ${provider}`}
        </Button>
    );
}

