import { PageSkeleton } from '@/components/ui/loading-patterns';

export default function Loading() {
    return (
        <PageSkeleton
            variant="list"
            className="mx-auto max-w-6xl"
            label="Loading your games"
        />
    );
}

