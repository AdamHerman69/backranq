import type { GameUserSide, Prisma } from '@prisma/client';

export type UserGameOutcome = 'W' | 'L' | 'D' | '?';
export type UserResultFilter = 'wins' | 'losses' | 'draws';

export function normalizeChessUsername(value: string | null | undefined) {
    return (value ?? '')
        .trim()
        .toLocaleLowerCase('en-US')
        .replace(/\s+/g, ' ')
        .replace(/^@/, '');
}

export function getUserGameOutcome(args: {
    result: string | null;
    userSide: GameUserSide | 'white' | 'black' | 'unknown';
}): UserGameOutcome {
    const userIsWhite = args.userSide === 'WHITE' || args.userSide === 'white';
    const userIsBlack = args.userSide === 'BLACK' || args.userSide === 'black';
    if (!userIsWhite && !userIsBlack) return '?';
    if (args.result === '1/2-1/2') return 'D';

    if (userIsWhite) {
        if (args.result === '1-0') return 'W';
        if (args.result === '0-1') return 'L';
    }
    if (userIsBlack) {
        if (args.result === '0-1') return 'W';
        if (args.result === '1-0') return 'L';
    }

    return '?';
}

export function buildUserResultWhere(args: {
    result: UserResultFilter;
}): Prisma.AnalyzedGameWhereInput {
    if (args.result === 'draws') {
        return { userSide: { in: ['WHITE', 'BLACK'] }, result: '1/2-1/2' };
    }
    return {
        OR: [
            {
                userSide: 'WHITE',
                result: args.result === 'wins' ? '1-0' : '0-1',
            },
            {
                userSide: 'BLACK',
                result: args.result === 'wins' ? '0-1' : '1-0',
            },
        ],
    };
}

export function buildOpponentSearchWhere(args: {
    query: string;
}): Prisma.AnalyzedGameWhereInput {
    const query = args.query.trim();
    if (!query) return {};
    return {
        OR: [
            {
                userSide: 'WHITE',
                blackName: { contains: query, mode: 'insensitive' },
            },
            {
                userSide: 'BLACK',
                whiteName: { contains: query, mode: 'insensitive' },
            },
        ],
    };
}

export function buildUserGameFiltersWhere(args: {
    result?: UserResultFilter | null;
    opponentQuery?: string;
}): Prisma.AnalyzedGameWhereInput {
    const filters: Prisma.AnalyzedGameWhereInput[] = [];
    if (args.result) {
        filters.push(
            buildUserResultWhere({ result: args.result })
        );
    }
    if (args.opponentQuery?.trim()) {
        filters.push(
            buildOpponentSearchWhere({ query: args.opponentQuery })
        );
    }
    return filters.length > 0 ? { AND: filters } : {};
}
