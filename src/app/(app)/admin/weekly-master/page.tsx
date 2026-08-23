import { WeeklyMasterControlRoom } from '@/components/admin/WeeklyMasterControlRoom';
import { requireAdminSession } from '@/lib/auth/admin';
import { getWeeklyMasterAdminSnapshot } from '@/lib/master/adminReadService';

export const dynamic = 'force-dynamic';

export default async function WeeklyMasterAdminPage() {
    const principal = await requireAdminSession('MASTER_VIEW');
    const snapshot = await getWeeklyMasterAdminSnapshot();

    return (
        <WeeklyMasterControlRoom
            snapshot={snapshot}
            role={principal.role}
            capabilities={[...principal.capabilities]}
        />
    );
}
