'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { SignInButton } from '@/components/auth/SignInButton';
import { SignOutButton } from '@/components/auth/SignOutButton';
import { UserAvatar } from '@/components/auth/UserAvatar';

function NavLink({
    href,
    label,
}: {
    href: string;
    label: string;
}) {
    const pathname = usePathname();
    const active = pathname === href;
    return (
        <Link
            href={href}
            style={{
                textDecoration: active ? 'underline' : 'none',
                fontWeight: active ? 700 : 600,
                color: 'var(--text-primary, #000)',
            }}
        >
            {label}
        </Link>
    );
}

export function AppNav() {
    const { data } = useSession();
    const authed = !!data?.user?.id;

    return (
        <div
            style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                padding: '10px 0 6px',
                borderBottom: '1px solid var(--border, #e6e6e6)',
            }}
        >
            <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
                <NavLink href="/" label="Home" />
                <NavLink href="/games" label="Games" />
                <NavLink href="/puzzles" label="Puzzles" />
                <NavLink href="/settings" label="Settings" />
                <NavLink href="/profile" label="Profile" />
            </div>

            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                {authed ? (
                    <>
                        <UserAvatar />
                        <SignOutButton>Sign out</SignOutButton>
                    </>
                ) : (
                    <SignInButton provider="github" callbackUrl="/dashboard">
                        Sign in
                    </SignInButton>
                )}
            </div>
        </div>
    );
}


