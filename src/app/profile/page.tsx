import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { SignOutButton } from '@/components/auth/SignOutButton';
import Link from 'next/link';
import { ArrowRight, CheckCircle2, Gamepad2, LogOut, Settings2, UserRound } from 'lucide-react';
import { PageHeader } from '@/components/app/PageHeader';
import { Button } from '@/components/ui/button';
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import {
    chessAccountConnectionSelect,
    linkedUsernameSnapshot,
} from '@/lib/accounts/chessAccountConnections';

export default async function ProfilePage() {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) redirect('/login?callbackUrl=/profile');

    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
            email: true,
            name: true,
            image: true,
            chessAccountConnections: {
                select: chessAccountConnectionSelect,
            },
        },
    });

    const linked = linkedUsernameSnapshot(user?.chessAccountConnections ?? []);
    const connectionCount = [
        linked.lichessUsername,
        linked.chesscomUsername,
    ].filter(Boolean).length;
    const displayName = user?.name || user?.email || 'Backranq player';
    const initials = displayName
        .split(/\s+/)
        .slice(0, 2)
        .map((part) => part[0])
        .join('')
        .toUpperCase();

    return (
        <div className="space-y-6 sm:space-y-8">
            <PageHeader
                eyebrow="Account"
                title="Profile"
                subtitle="Your Backranq identity, connected chess profiles, and session controls."
            />

            <Card variant="floating" className="overflow-hidden">
                <CardContent className="p-5 sm:p-6">
                    <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
                        <div className="flex min-w-0 items-center gap-4">
                            <Avatar className="h-16 w-16 border border-border/70 shadow-control">
                                {user?.image ? (
                                    <AvatarImage src={user.image} alt="" />
                                ) : null}
                                <AvatarFallback className="bg-primary/10 text-lg font-semibold text-primary">
                                    {initials || <UserRound aria-hidden="true" />}
                                </AvatarFallback>
                            </Avatar>
                            <div className="min-w-0">
                                <h2 className="truncate text-xl font-semibold tracking-[-0.03em]">
                                    {displayName}
                                </h2>
                                <p className="mt-0.5 truncate text-sm text-muted-foreground">
                                    {user?.email ?? 'No email attached'}
                                </p>
                                <Badge
                                    variant="outline"
                                    className={
                                        connectionCount > 0
                                            ? 'mt-2 border-success/20 bg-success/10 text-success'
                                            : 'mt-2 bg-card text-muted-foreground'
                                    }
                                >
                                    {connectionCount > 0 ? (
                                        <CheckCircle2 className="mr-1 h-3 w-3" aria-hidden="true" />
                                    ) : null}
                                    {connectionCount > 0
                                        ? `${connectionCount} chess ${connectionCount === 1 ? 'source' : 'sources'} connected`
                                        : 'No chess sources connected'}
                                </Badge>
                            </div>
                        </div>
                        <div className="grid grid-cols-2 gap-2 sm:flex sm:shrink-0">
                            <Button asChild>
                                <Link href="/settings">
                                    <Settings2 aria-hidden="true" />
                                    Settings
                                </Link>
                            </Button>
                            <Button asChild variant="outline">
                                <Link href="/games">
                                    <Gamepad2 aria-hidden="true" />
                                    Your games
                                </Link>
                            </Button>
                        </div>
                    </div>
                </CardContent>
            </Card>

            <Card variant="panel" className="overflow-hidden">
                <CardHeader className="border-b border-border/70 bg-surface-subtle/50">
                    <CardTitle className="text-base">Chess sources</CardTitle>
                    <CardDescription>
                        These public profiles feed your game library and training queue.
                    </CardDescription>
                </CardHeader>
                <CardContent className="divide-y divide-border/70 p-0">
                    <ProviderRow label="Lichess" username={linked.lichessUsername} />
                    <ProviderRow label="Chess.com" username={linked.chesscomUsername} />
                    <div className="p-3 sm:p-4">
                        <Button asChild variant="ghost" size="sm" className="w-full justify-between sm:w-auto">
                            <Link href="/settings#connections">
                                Manage connections and sync
                                <ArrowRight aria-hidden="true" />
                            </Link>
                        </Button>
                    </div>
                </CardContent>
            </Card>

            <Card variant="subtle">
                <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
                    <div>
                        <p className="text-sm font-medium">Session on this device</p>
                        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                            Signing out clears your local coach session but keeps your account and games.
                        </p>
                    </div>
                    <SignOutButton
                        variant="outline"
                        className="border-destructive/20 text-destructive hover:bg-destructive/5 hover:text-destructive"
                    >
                        <LogOut aria-hidden="true" />
                        Sign out
                    </SignOutButton>
                </CardContent>
            </Card>
        </div>
    );
}

function ProviderRow({
    label,
    username,
}: {
    label: string;
    username: string | null;
}) {
    return (
        <div className="flex min-h-16 items-center justify-between gap-4 px-4 py-3">
            <div>
                <p className="text-sm font-medium">{label}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                    {username ? `@${username}` : 'No profile connected'}
                </p>
            </div>
            <Badge
                variant="outline"
                className={
                    username
                        ? 'border-success/20 bg-success/10 text-success'
                        : 'bg-card text-muted-foreground'
                }
            >
                {username ? 'Connected' : 'Not connected'}
            </Badge>
        </div>
    );
}
