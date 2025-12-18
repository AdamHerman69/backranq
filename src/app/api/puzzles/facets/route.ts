import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { ecoName } from '@/lib/chess/eco';
import { Prisma } from '@prisma/client';

export const runtime = 'nodejs';

function clampInt(v: number, min: number, max: number) {
    return Math.max(min, Math.min(max, v));
}

export async function GET(req: Request) {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId)
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const url = new URL(req.url);
    const limit = clampInt(
        Number(url.searchParams.get('limit') ?? '200') || 200,
        1,
        1000
    );

    const [openings, tagsAgg] = await Promise.all([
        prisma.$queryRaw<
            {
                openingEco: string | null;
                openingName: string | null;
                openingVariation: string | null;
                count: bigint;
            }[]
        >`
            SELECT
              "openingEco",
              MAX("openingName") AS "openingName",
              MAX("openingVariation") AS "openingVariation",
              COUNT(*) AS "count"
            FROM "Puzzle"
            WHERE "userId" = ${Prisma.sql`${userId}::uuid`}
              AND "openingEco" IS NOT NULL
            GROUP BY "openingEco"
            ORDER BY COUNT(*) DESC
            LIMIT ${limit};
        `,
        prisma.$queryRaw<{ tag: string; count: bigint }[]>`
            SELECT t.tag AS tag, COUNT(*) AS count
            FROM "Puzzle" p, UNNEST(p."tags") AS t(tag)
            WHERE p."userId" = ${Prisma.sql`${userId}::uuid`}
            GROUP BY t.tag
            ORDER BY COUNT(*) DESC
            LIMIT ${limit};
        `,
    ]);

    const openingOptions = openings
        .map((o) => {
            const eco = (o.openingEco ?? '').trim().toUpperCase();
            if (!eco) return null;
            const nm = (o.openingName ?? '').trim() || ecoName(eco) || '';
            const variation = (o.openingVariation ?? '').trim();
            const label = `${eco}${nm ? ` ${nm}` : ''}${
                variation ? ` — ${variation}` : ''
            }`.trim();
            return {
                value: eco,
                label,
                count: Number(o.count ?? 0n),
            };
        })
        .filter(Boolean)
        .slice(0, limit);

    const tagOptions = tagsAgg
        .map((t) => {
            const tag = String(t.tag ?? '').trim();
            if (!tag) return null;
            return { value: tag, label: tag, count: Number(t.count ?? 0n) };
        })
        .filter(Boolean)
        .slice(0, limit);

    return NextResponse.json({
        openings: openingOptions,
        tags: tagOptions,
    });
}
