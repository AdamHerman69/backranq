'use client';

import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { ChessAccountLink } from './ChessAccountLink';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export type UserProfile = {
    id: string;
    email: string;
    name: string | null;
    image: string | null;
    lichessUsername: string | null;
    chesscomUsername: string | null;
};

type Props = {
    initialUser: UserProfile;
};

export function ProfileForm({ initialUser }: Props) {
    const [user, setUser] = useState<UserProfile>(initialUser);

    const update = useCallback(
        async (patch: Partial<Pick<UserProfile, 'lichessUsername' | 'chesscomUsername'>>) => {
            const res = await fetch('/api/user/profile', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(patch),
            });
            const json = (await res.json().catch(() => ({}))) as
                | { user: UserProfile }
                | { error?: string };
            if (!res.ok) {
                const msg =
                    'error' in json && typeof json.error === 'string'
                        ? json.error
                        : 'Update failed';
                throw new Error(msg);
            }
            if ('user' in json) setUser(json.user);
        },
        []
    );

    async function updateLichess(next: string) {
        const id = toast.loading('Saving Lichess username…');
        try {
            await update({ lichessUsername: next || null });
            toast.success('Lichess username saved', { id });
        } catch (e) {
            toast.error(e instanceof Error ? e.message : 'Save failed', { id });
        }
    }

    async function updateChesscom(next: string) {
        const id = toast.loading('Saving Chess.com username…');
        try {
            await update({ chesscomUsername: next || null });
            toast.success('Chess.com username saved', { id });
        } catch (e) {
            toast.error(e instanceof Error ? e.message : 'Save failed', { id });
        }
    }

    return (
        <div className="space-y-6">
            <Card>
                <CardHeader>
                    <CardTitle className="text-base">Profile</CardTitle>
                    <CardDescription>
                        {user.email}
                        {user.name ? ` • ${user.name}` : ''}
                    </CardDescription>
                </CardHeader>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle className="text-base">Linked accounts</CardTitle>
                    <CardDescription>
                        Validate usernames so Backranq can import games from your public profiles.
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                    <ChessAccountLink
                        provider="lichess"
                        currentUsername={user.lichessUsername}
                        onUpdate={updateLichess}
                    />
                    <ChessAccountLink
                        provider="chesscom"
                        currentUsername={user.chesscomUsername}
                        onUpdate={updateChesscom}
                    />
                </CardContent>
            </Card>
        </div>
    );
}


