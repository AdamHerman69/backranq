import { PageSkeleton } from '@/components/ui/loading-patterns';

export default function HomeLoading() {
    return (
        <PageSkeleton
            className="mx-auto max-w-6xl"
            label="Loading your next move"
        />
    );
}
