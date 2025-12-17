'use client';

import { signOut } from 'next-auth/react';
import type { ReactNode } from 'react';

import { Button, type ButtonProps } from '@/components/ui/button';

type Props = {
    callbackUrl?: string;
    children?: ReactNode;
    variant?: ButtonProps['variant'];
    size?: ButtonProps['size'];
    className?: string;
};

export function SignOutButton({
    callbackUrl = '/',
    children,
    variant = 'outline',
    size = 'default',
    className,
}: Props) {
    return (
        <Button
            type="button"
            onClick={() => signOut({ callbackUrl })}
            variant={variant}
            size={size}
            className={className}
        >
            {children ?? 'Sign out'}
        </Button>
    );
}

