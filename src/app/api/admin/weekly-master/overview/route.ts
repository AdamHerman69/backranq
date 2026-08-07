import { NextResponse } from 'next/server';

import { isAdminApiResponse, requireAdminApi } from '@/lib/admin/http';
import { getWeeklyMasterAdminSnapshot } from '@/lib/master/adminReadService';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
    const principal = await requireAdminApi('MASTER_VIEW');
    if (isAdminApiResponse(principal)) return principal;

    const snapshot = await getWeeklyMasterAdminSnapshot();
    return NextResponse.json(
        {
            principal: {
                role: principal.role,
                capabilities: principal.capabilities,
            },
            snapshot,
        },
        { headers: { 'Cache-Control': 'private, no-store' } }
    );
}
