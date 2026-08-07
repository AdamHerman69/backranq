import { PageHeader } from '@/components/app/PageHeader';
import { CoachOfflineShell } from '@/components/coach/CoachOfflineShell';

export const dynamic = 'force-static';

export default function OfflineCoachPage() {
    return (
        <div className="space-y-4">
            <PageHeader
                title="Play with a coach"
                subtitle="Play and review with the local coach—even while this device is offline."
            />
            <CoachOfflineShell />
        </div>
    );
}
