import type { Prisma } from '@prisma/client';
import {
    isStrictIsoDate,
    isStrictIsoInstant,
} from '@/lib/api/validation';

export type GamesAnalysisState =
    | 'analyzed'
    | 'needs-analysis';

export function parseGamesDateBound(
    value: string,
    edge: 'start' | 'end'
): Date | null {
    if (isStrictIsoInstant(value)) return new Date(value);
    if (!isStrictIsoDate(value)) return null;
    return new Date(
        `${value}T${edge === 'start' ? '00:00:00.000' : '23:59:59.999'}Z`
    );
}

export function gamesAnalysisStateWhere(
    state: GamesAnalysisState
): Prisma.AnalyzedGameWhereInput {
    if (state === 'analyzed') {
        return { currentAnalysisValid: true };
    }
    return { currentAnalysisValid: false };
}
