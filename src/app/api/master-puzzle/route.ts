import { NextResponse } from 'next/server';
import { getPublicMasterSlot } from '@/lib/master/publication';

export const runtime = 'nodejs';

export async function GET(req: Request) {
    const result = await getPublicMasterSlot();
    const publicationId =
        result.state === 'unavailable' ? 'none' : result.publication.id;
    const publicationHealth =
        result.state === 'unavailable' ? 'none' : result.publication.health;
    const etag = `"master-${result.slot.version}-${result.state}-${publicationId}-${publicationHealth}"`;
    if (req.headers.get('if-none-match') === etag) {
        return new NextResponse(null, {
            status: 304,
            headers: { ETag: etag },
        });
    }
    return NextResponse.json(result, {
        headers: {
            ETag: etag,
            'Cache-Control':
                result.state === 'unavailable'
                    ? 'public, s-maxage=30, stale-while-revalidate=60'
                    : 'public, s-maxage=60, stale-while-revalidate=120',
        },
    });
}
