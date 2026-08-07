import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { LockKeyhole, RadioTower } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { auth } from '@/lib/auth';
import { getAdminPrincipal, roleHasCapability } from '@/lib/auth/admin';

export const dynamic = 'force-dynamic';

export default async function AdminLayout({
    children,
}: Readonly<{ children: React.ReactNode }>) {
    const principal = await getAdminPrincipal();
    if (!principal) {
        const session = await auth();
        if (!session?.user?.id) {
            redirect('/login?callbackUrl=/admin/weekly-master');
        }
        notFound();
    }

    return (
        <div className="space-y-6 sm:space-y-8">
            <div className="flex flex-col gap-3 rounded-lg border border-border/80 bg-surface-raised/90 p-3 shadow-control backdrop-blur-sm sm:flex-row sm:items-center sm:justify-between sm:p-4">
                <div className="flex min-w-0 items-center gap-3">
                    <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                        <RadioTower className="h-4 w-4" aria-hidden="true" />
                    </span>
                    <div>
                        <p className="text-sm font-semibold tracking-[-0.01em]">Backranq control room</p>
                        <p className="text-xs text-muted-foreground">
                            Production editorial and pipeline operations
                        </p>
                    </div>
                    <Badge variant="outline" className="hidden gap-1 bg-card sm:inline-flex">
                        <LockKeyhole className="h-3 w-3" aria-hidden="true" />
                        {principal.role}
                    </Badge>
                </div>
                <nav aria-label="Admin" className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
                    <Button asChild variant="quiet" size="sm" className="w-full sm:w-auto">
                        <Link href="/admin/weekly-master">Weekly Master</Link>
                    </Button>
                    {roleHasCapability(principal.role, 'PREMIUM_MANAGE') ? (
                        <Button asChild variant="quiet" size="sm" className="w-full sm:w-auto">
                            <Link href="/admin/premium">Premium</Link>
                        </Button>
                    ) : null}
                </nav>
            </div>
            {children}
        </div>
    );
}
