import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { Prisma } from '@prisma/client';
import {
    defaultPreferences,
    mergePreferences,
    type PartialPreferences,
} from '@/lib/preferences';

export const runtime = 'nodejs';

export async function GET() {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { preferences: true },
    });

    const prefs = mergePreferences(
        defaultPreferences(),
        (user?.preferences ?? {}) as PartialPreferences
    );

    return NextResponse.json({ preferences: prefs });
}

export async function PUT(req: Request) {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const patch = (await req.json().catch(() => ({}))) as PartialPreferences;

    const cur = await prisma.user.findUnique({
        where: { id: userId },
        select: { preferences: true },
    });

    const merged = mergePreferences(
        defaultPreferences(),
        (cur?.preferences ?? {}) as PartialPreferences
    );
    const next = mergePreferences(merged, patch);

    await prisma.user.update({
        where: { id: userId },
        data: { preferences: next as unknown as Prisma.InputJsonValue },
    });

    return NextResponse.json({ preferences: next });
}

