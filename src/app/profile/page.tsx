import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { SignOutButton } from '@/components/auth/SignOutButton';
import Link from 'next/link';
import { PageHeader } from '@/components/app/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';

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
            lichessUsername: true,
            chesscomUsername: true,
        },
    });

    return (
        <div className="space-y-6">
            <PageHeader title="Profile" subtitle="Your account and linked chess providers." />

            <Card>
                <CardContent className="pt-6">
                    <dl className="grid gap-4 sm:grid-cols-2">
                        <div>
                            <dt className="text-sm text-muted-foreground">Email</dt>
                            <dd className="mt-1 text-sm font-medium">{user?.email ?? '—'}</dd>
                        </div>
                        <div>
                            <dt className="text-sm text-muted-foreground">Name</dt>
                            <dd className="mt-1 text-sm font-medium">{user?.name ?? '—'}</dd>
                        </div>
                        <div>
                            <dt className="text-sm text-muted-foreground">Lichess</dt>
                            <dd className="mt-1 text-sm font-medium">
                                {user?.lichessUsername ?? '—'}
                            </dd>
                        </div>
                        <div>
                            <dt className="text-sm text-muted-foreground">Chess.com</dt>
                            <dd className="mt-1 text-sm font-medium">
                                {user?.chesscomUsername ?? '—'}
                            </dd>
                        </div>
                    </dl>

                    <Separator className="my-6" />

                    <div className="flex flex-wrap items-center gap-2">
                        <Button asChild variant="outline">
                            <Link href="/settings">Edit settings</Link>
                        </Button>
                        <Button asChild variant="outline">
                            <Link href="/games">Your games</Link>
                        </Button>
                        <SignOutButton variant="outline">Sign out</SignOutButton>
                    </div>
                </CardContent>
            </Card>
        </div>
    );
}


