import { PageHeader } from '@/components/app/PageHeader';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

export default function ProgressLoading() {
    return (
        <div
            className="space-y-5 sm:space-y-6"
            role="status"
            aria-label="Loading Progress"
        >
            <PageHeader
                title="Progress"
                subtitle="Preparing the next useful action and the evidence behind it…"
            />
            <Card className="border-primary/20">
                <CardContent className="flex flex-col gap-4 py-5 sm:flex-row sm:items-center sm:justify-between sm:py-6">
                    <div className="flex flex-1 gap-3">
                        <Skeleton className="h-9 w-9 shrink-0 rounded-full" />
                        <div className="flex-1 space-y-2">
                            <Skeleton className="h-3 w-28" />
                            <Skeleton className="h-6 w-2/3" />
                            <Skeleton className="h-4 w-full max-w-xl" />
                        </div>
                    </div>
                    <Skeleton className="h-12 w-full rounded-lg sm:w-40" />
                </CardContent>
            </Card>
            <Skeleton className="h-32 w-full rounded-lg sm:h-24" />
            <div>
                <div className="mb-2 flex justify-between px-1">
                    <Skeleton className="h-3 w-24" />
                    <Skeleton className="h-3 w-20" />
                </div>
                <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border lg:grid-cols-4">
                    {Array.from({ length: 4 }).map((_, index) => (
                        <div key={index} className="bg-card p-3 sm:p-4">
                            <Skeleton className="h-3 w-24" />
                            <Skeleton className="mt-2 h-6 w-20" />
                            <Skeleton className="mt-2 h-3 w-full" />
                        </div>
                    ))}
                </div>
            </div>
            <div className="space-y-3">
                {Array.from({ length: 3 }).map((_, index) => (
                    <div
                        key={index}
                        className="flex min-h-16 items-center justify-between rounded-lg border bg-card px-4 py-3 sm:px-5"
                    >
                        <div className="flex-1 space-y-2">
                            <Skeleton className="h-4 w-36" />
                            <Skeleton className="h-3 w-3/4" />
                        </div>
                        <Skeleton className="h-5 w-5 rounded-full" />
                    </div>
                ))}
            </div>
            <span className="sr-only">Loading Progress data.</span>
        </div>
    );
}
