'use client';

import { useSession } from 'next-auth/react';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';

function initials(nameOrEmail: string) {
    const parts = nameOrEmail.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return '?';
    if (parts.length === 1) return parts[0]?.slice(0, 2).toUpperCase() ?? '?';
    const a = parts[0]?.[0] ?? '';
    const b = parts[parts.length - 1]?.[0] ?? '';
    return `${a}${b}`.toUpperCase() || '?';
}

export function UserAvatar() {
    const { data } = useSession();
    const user = data?.user;
    const label = user?.name ?? user?.email ?? 'User';
    const img = user?.image ?? undefined;

    return (
        <Avatar className="h-8 w-8" aria-label={label}>
            <AvatarImage src={img} alt={label} />
            <AvatarFallback>{initials(label)}</AvatarFallback>
        </Avatar>
    );
}

