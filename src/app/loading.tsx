import { BoardSkeleton } from '@/components/ui/loading-patterns';
import { Skeleton } from '@/components/ui/skeleton';

export default function Loading() {
    return (
        <div className="min-h-dvh bg-background" role="status" aria-label="Preparing Backranq">
            <header className="border-b bg-background/90">
                <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-4 sm:px-6">
                    <Skeleton className="h-6 w-28" />
                    <Skeleton className="h-10 w-20 rounded-md" />
                </div>
            </header>
            <main className="relative overflow-hidden border-b">
                <div className="mx-auto grid max-w-7xl gap-x-14 gap-y-4 px-2 pb-7 pt-4 sm:gap-y-6 sm:px-6 sm:py-12 lg:grid-cols-[minmax(320px,0.78fr)_minmax(0,1.22fr)] lg:grid-rows-[auto_1fr] lg:items-start lg:py-16">
                    <div className="space-y-3 px-1 lg:col-start-1 lg:row-start-1 lg:px-0" aria-hidden="true">
                        <Skeleton className="h-3 w-36" />
                        <Skeleton className="h-10 w-full sm:h-14" />
                        <Skeleton className="h-10 w-4/5 sm:h-14" />
                        <Skeleton className="hidden h-5 w-full max-w-lg sm:block" />
                        <Skeleton className="hidden h-5 w-4/5 max-w-md sm:block" />
                    </div>

                    <div className="min-w-0 rounded-[1.4rem] border border-border/70 bg-background/90 p-1 shadow-card sm:p-5 lg:col-start-2 lg:row-span-2 lg:row-start-1">
                        <div className="space-y-2 px-2 pb-2 pt-1" aria-hidden="true">
                            <Skeleton className="h-3 w-24" />
                            <Skeleton className="h-6 w-64 max-w-full" />
                        </div>
                        <BoardSkeleton />
                        <Skeleton className="mx-2 mt-3 h-11 rounded-lg" />
                    </div>

                    <div className="space-y-3 px-1 lg:col-start-1 lg:row-start-2 lg:px-0" aria-hidden="true">
                        <div className="grid gap-2 sm:grid-cols-[150px_minmax(0,1fr)]">
                            <Skeleton className="h-12 w-full rounded-md" />
                            <Skeleton className="h-12 w-full rounded-md" />
                        </div>
                        <Skeleton className="h-12 w-full rounded-md" />
                        <Skeleton className="h-4 w-3/4" />
                        <Skeleton className="h-[122px] w-full rounded-2xl" />
                    </div>
                </div>
            </main>
            <span className="sr-only">Preparing Backranq</span>
        </div>
    );
}
