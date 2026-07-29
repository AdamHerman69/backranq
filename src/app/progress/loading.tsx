import { PageHeader } from '@/components/app/PageHeader';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

export default function ProgressLoading() {
    return (
        <div className="space-y-6" role="status" aria-label="Loading Progress">
            <PageHeader
                title="Progress"
                subtitle="Loading the evidence behind your next step…"
            />
            <Skeleton className="h-36 w-full rounded-xl" />
            <Card>
                <CardContent className="grid grid-cols-2 gap-3 py-6 lg:grid-cols-4">
                    {Array.from({ length: 4 }).map((_, index) => (
                        <Skeleton
                            key={index}
                            className="h-20 w-full rounded-lg"
                        />
                    ))}
                </CardContent>
            </Card>
            <Skeleton className="h-32 w-full rounded-xl" />
            <span className="sr-only">Loading Progress data.</span>
        </div>
    );
}
