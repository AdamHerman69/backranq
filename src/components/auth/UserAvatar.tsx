'use client';

import { useSession } from 'next-auth/react';

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

    if (img) {
        // eslint-disable-next-line @next/next/no-img-element
        return <img src={img} alt={label} width={32} height={32} />;
    }

    return (
        <div
            aria-label={label}
            style={{
                width: 32,
                height: 32,
                borderRadius: 999,
                background: '#eee',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 12,
                fontWeight: 600,
            }}
        >
            {initials(label)}
        </div>
    );
}

