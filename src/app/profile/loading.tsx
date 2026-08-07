import { PageSkeleton } from '@/components/ui/loading-patterns';

export default function ProfileLoading() {
    return (
        <PageSkeleton
            variant="reading"
            label="Loading Profile"
        />
    );
}
