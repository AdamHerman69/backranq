import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { auth } from '@/lib/auth';
import { getAdminPrincipal } from '@/lib/auth/admin';

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
        <div className="space-y-6">
            <div className="flex flex-col gap-3 rounded-xl border bg-muted/25 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-3">
                    <div>
                        <p className="text-sm font-semibold">Backranq control room</p>
                        <p className="text-xs text-muted-foreground">
                            Production editorial and pipeline operations
                        </p>
                    </div>
                    <Badge variant="outline">{principal.role}</Badge>
                </div>
                <nav aria-label="Admin">
                    <Button asChild variant="secondary" size="sm">
                        <Link href="/admin/weekly-master">Weekly Master</Link>
                    </Button>
                </nav>
            </div>
            {children}
        </div>
    );
}
