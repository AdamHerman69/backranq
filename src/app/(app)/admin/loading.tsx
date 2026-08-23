import { PageSkeleton } from '@/components/ui/loading-patterns';

export default function AdminLoading() {
    return (
        <PageSkeleton
            className="mx-auto max-w-[1680px]"
            label="Loading the Backranq control room"
        />
    );
}
