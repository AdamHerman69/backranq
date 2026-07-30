import { PageHeader } from '@/components/app/PageHeader';
import { CoachOfflineShell } from '@/components/coach/CoachOfflineShell';

export const dynamic = 'force-static';

export default function OfflineCoachPage() {
    return (
        <div className="space-y-6">
            <PageHeader
                title="Play with a coach"
                subtitle="Offline coach shell · your active game is saved only on this device."
            />
            <CoachOfflineShell />
        </div>
    );
}
