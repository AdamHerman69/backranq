import { NextResponse } from 'next/server';
import { getAnalysisOpsSnapshot } from '@/lib/services/analysisOps';

export const runtime = 'nodejs';

function adminSecret() {
    const value =
        process.env.BACKRANQ_ADMIN_API_SECRET ?? process.env.ADMIN_API_SECRET;
    return value && value.trim() ? value : null;
}

function authorized(req: Request) {
    const secret = adminSecret();
    if (!secret) return false;
    return req.headers.get('authorization') === `Bearer ${secret}`;
}

export async function GET(req: Request) {
    if (!adminSecret()) {
        return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    if (!authorized(req)) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const snapshot = await getAnalysisOpsSnapshot();
    return NextResponse.json({ ok: true, snapshot });
}
