import { PageSkeleton } from '@/components/ui/loading-patterns';

export default function SettingsLoading() {
    return (
        <PageSkeleton
            variant="reading"
            label="Loading Settings"
        />
    );
}
