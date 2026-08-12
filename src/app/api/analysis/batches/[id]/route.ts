import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { getOwnedAnalysisBatch } from '@/lib/services/analysisBatches';

export const runtime = 'nodejs';

const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(
    req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { id } = await params;
    if (!UUID_PATTERN.test(id)) {
        return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    const url = new URL(req.url);
    const cursor = url.searchParams.get('cursor')?.trim();
    if (cursor && !UUID_PATTERN.test(cursor)) {
        return NextResponse.json({ error: 'Invalid cursor' }, { status: 400 });
    }
    const rawLimit = Number(url.searchParams.get('limit') ?? 100);
    if (!Number.isFinite(rawLimit)) {
        return NextResponse.json({ error: 'Invalid limit' }, { status: 400 });
    }
    const result = await getOwnedAnalysisBatch(userId, id, {
        cursor,
        limit: rawLimit,
    });
    if (!result) {
        return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    return NextResponse.json(result, {
        headers: { 'Cache-Control': 'private, no-store' },
    });
}
