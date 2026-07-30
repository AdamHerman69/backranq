'use client';

import { useSession } from 'next-auth/react';
import type { ReactNode } from 'react';
import { toast } from 'sonner';

import { Button, type ButtonProps } from '@/components/ui/button';
import { signOutAndClearCoachSession } from '@/lib/coach/signOut';

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
    const { data } = useSession();
    return (
        <Button
            type="button"
            onClick={() => {
                void signOutAndClearCoachSession(
                    data?.user?.id,
                    callbackUrl
                ).catch(() => {
                    toast.error(
                        'Could not sign out. Your local coach game was left intact.'
                    );
                });
            }}
            variant={variant}
            size={size}
            className={className}
        >
            {children ?? 'Sign out'}
        </Button>
    );
}
