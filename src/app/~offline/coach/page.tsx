import { PageHeader } from '@/components/app/PageHeader';
import { CoachGame } from '@/components/coach/CoachGame';
import { CoachOfflineRegistration } from '@/components/coach/CoachOfflineRegistration';

export const dynamic = 'force-static';

export default function OfflineCoachPage() {
    return (
        <div className="space-y-6">
            <PageHeader
                title="Play with a coach"
                subtitle="Offline coach shell · your active game is saved only on this device."
            />
            <CoachOfflineRegistration />
            <CoachGame />
        </div>
    );
}
