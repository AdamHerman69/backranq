import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';

export async function GET(
    _req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId)
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id } = await params;
    const game = await prisma.analyzedGame.findFirst({
        where: { id, userId },
        // Avoid over-fetching large columns (notably `analysis`) for the trainer.
        // The client only needs metadata + PGN to reconstruct moves.
        select: {
            id: true,
            provider: true,
            externalId: true,
            url: true,
            pgn: true,
            playedAt: true,
            timeClass: true,
            rated: true,
            result: true,
            termination: true,
            whiteName: true,
            whiteRating: true,
            blackName: true,
            blackRating: true,
            openingEco: true,
            openingName: true,
            openingVariation: true,
        },
    });
    if (!game)
        return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ game });
}

export async function PATCH(
    req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId)
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id } = await params;
    const body = (await req.json().catch(() => ({}))) as Partial<{
        url: string | null;
        pgn: string;
        result: string | null;
        termination: string | null;
        openingEco: string | null;
        openingName: string | null;
        openingVariation: string | null;
        analyzedAt: string | null;
    }>;

    const exists = await prisma.analyzedGame.findFirst({
        where: { id, userId },
        select: { id: true },
    });
    if (!exists)
        return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const game = await prisma.analyzedGame.update({
        where: { id },
        data: {
            url: body.url ?? undefined,
            pgn: body.pgn ?? undefined,
            result: body.result ?? undefined,
            termination: body.termination ?? undefined,
            openingEco: body.openingEco ?? undefined,
            openingName: body.openingName ?? undefined,
            openingVariation: body.openingVariation ?? undefined,
            analyzedAt:
                body.analyzedAt === null
                    ? null
                    : typeof body.analyzedAt === 'string'
                    ? new Date(body.analyzedAt)
                    : undefined,
        },
    });

    return NextResponse.json({ game });
}

export async function DELETE(
    _req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId)
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id } = await params;
    const exists = await prisma.analyzedGame.findFirst({
        where: { id, userId },
        select: { id: true },
    });
    if (!exists)
        return NextResponse.json({ error: 'Not found' }, { status: 404 });

    await prisma.analyzedGame.delete({ where: { id } });
    return NextResponse.json({ ok: true });
}

