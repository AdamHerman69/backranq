'use client';

import { useId, useState, type ReactNode } from 'react';

import { Button, type ButtonProps } from '@/components/ui/button';
import { signOutAndClearCoachSession } from '@/lib/coach/signOut';

type Props = {
    ownerId?: string | null;
    callbackUrl?: string;
    children?: ReactNode;
    variant?: ButtonProps['variant'];
    size?: ButtonProps['size'];
    className?: string;
};

export function SignOutButton({
    ownerId,
    callbackUrl = '/',
    children,
    variant = 'outline',
    size = 'default',
    className,
}: Props) {
    const errorId = useId();
    const [error, setError] = useState<string | null>(null);
    return (
        <>
            <Button
                type="button"
                aria-describedby={error ? errorId : undefined}
                onClick={() => {
                    setError(null);
                    void signOutAndClearCoachSession(
                        ownerId,
                        callbackUrl
                    ).catch(() => {
                        setError(
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
            {error ? (
                <span
                    id={errorId}
                    role="alert"
                    className="text-sm text-destructive"
                >
                    {error}
                </span>
            ) : null}
        </>
    );
}
