import { BoardSkeleton } from '@/components/ui/loading-patterns';
import { Skeleton } from '@/components/ui/skeleton';

export default function GameLoading() {
    return (
        <div
            className="mx-auto max-w-[1480px] space-y-4 sm:space-y-6"
            role="status"
            aria-label="Loading game review"
        >
            <Skeleton className="h-11 w-36 rounded-md sm:h-9" />

            <section className="overflow-hidden rounded-[1.4rem] border bg-card/80" aria-hidden="true">
                <div className="flex items-center justify-between border-b bg-muted/35 px-4 py-3">
                    <Skeleton className="h-3 w-48" />
                    <Skeleton className="h-7 w-20 rounded-full" />
                </div>
                <div className="grid gap-3 p-3 sm:p-4">
                    {[0, 1].map((row) => (
                        <div key={row} className="flex items-center gap-3">
                            <Skeleton className="h-8 w-8 rounded-md" />
                            <div className="min-w-0 flex-1 space-y-2">
                                <Skeleton className="h-4 w-2/5" />
                                <Skeleton className="h-3 w-1/4" />
                            </div>
                            <Skeleton className="h-6 w-16 rounded-full" />
                        </div>
                    ))}
                </div>
                <div className="border-t px-4 py-3">
                    <Skeleton className="h-3 w-56 max-w-full" />
                </div>
            </section>

            <section className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,720px)_minmax(320px,1fr)] xl:gap-6" aria-hidden="true">
                <div className="min-w-0">
                    <BoardSkeleton className="mx-auto max-w-[720px] rounded-[1.25rem]" />
                    <div className="mx-auto mt-2 flex h-[60px] w-full max-w-[720px] items-center justify-between rounded-2xl border bg-card/90 px-2">
                        <div className="flex gap-1">
                            {Array.from({ length: 5 }, (_, index) => (
                                <Skeleton key={index} className="h-11 w-11 rounded-md sm:h-10 sm:w-10" />
                            ))}
                        </div>
                        <Skeleton className="h-7 w-12" />
                    </div>
                </div>
                <div className="overflow-hidden rounded-[1.25rem] border bg-card/80">
                    <div className="grid grid-cols-3 gap-1 border-b p-2">
                        {Array.from({ length: 3 }, (_, index) => (
                            <Skeleton key={index} className="h-11 rounded-md sm:h-8" />
                        ))}
                    </div>
                    <div className="space-y-3 p-4 sm:p-5">
                        <Skeleton className="h-5 w-28" />
                        <Skeleton className="h-8 w-4/5" />
                        <Skeleton className="h-4 w-full" />
                        <Skeleton className="h-4 w-3/4" />
                        <Skeleton className="h-28 w-full rounded-xl" />
                    </div>
                </div>
            </section>
            <span className="sr-only">Loading game review</span>
        </div>
    );
}
