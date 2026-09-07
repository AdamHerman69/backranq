import type { PrismaClient } from '@prisma/client';
import { hashSourcePgn } from '@/lib/chess/pgn';

/** Existing canonical moments nominate work; only fresh evidence can retire them. */
export async function loadPracticeReassessmentTargets(args: {
    db: Pick<PrismaClient, 'trainingMoment'>;
    userId: string;
    gameId: string;
    pgn: string;
}) {
    const sourcePgnHash = hashSourcePgn(args.pgn);
    const moments = await args.db.trainingMoment.findMany({
        where: {
            userId: args.userId, gameId: args.gameId, sourcePgnHash,
            archivedAt: null, currentSolutionRevisionId: { not: null },
        },
        select: { decisionPly: true },
        orderBy: { decisionPly: 'asc' },
    });
    return { sourcePgnHash, decisionPlies: [...new Set(moments.map(moment => moment.decisionPly))] };
}
