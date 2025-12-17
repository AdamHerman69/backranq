import { PageHeader } from '@/components/app/PageHeader';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

export default function Loading() {
    return (
        <div className="space-y-6">
            <PageHeader title="Games" subtitle="Loading your games…" />
            <Card>
                <CardContent className="pt-6">
                    <div className="grid gap-3 md:grid-cols-2">
                        {Array.from({ length: 6 }).map((_, i) => (
                            <Skeleton key={i} className="h-28 w-full" />
                        ))}
                    </div>
                </CardContent>
            </Card>
        </div>
    );
}


