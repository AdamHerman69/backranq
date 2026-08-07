import { Gift } from 'lucide-react';

import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

export default function InvitationLoading() {
    return (
        <div className="flex min-h-[calc(100dvh-7rem)] items-center py-8" role="status" aria-label="Checking invitation">
            <Card className="mx-auto w-full max-w-xl overflow-hidden border-border/70 shadow-xl">
                <div className="h-1.5 bg-muted" aria-hidden="true" />
                <CardHeader className="space-y-4 sm:p-8">
                    <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-foreground text-background">
                        <Gift className="h-5 w-5" aria-hidden="true" />
                    </span>
                    <Skeleton className="h-8 w-4/5" />
                    <Skeleton className="h-12 w-full" />
                </CardHeader>
                <CardContent className="space-y-4 sm:px-8 sm:pb-8">
                    <div className="grid grid-cols-3 gap-2">
                        <Skeleton className="h-1.5 w-full" />
                        <Skeleton className="h-1.5 w-full" />
                        <Skeleton className="h-1.5 w-full" />
                    </div>
                    <Skeleton className="h-20 w-full rounded-xl" />
                    <Skeleton className="h-11 w-full rounded-xl" />
                </CardContent>
            </Card>
            <span className="sr-only">Checking whether this Pro invitation is ready.</span>
        </div>
    );
}
