import type { Prisma, Provider } from '@prisma/client';

export type UserGameOutcome = 'W' | 'L' | 'D' | '?';
export type UserResultFilter = 'wins' | 'losses' | 'draws';

export type ProviderUsernames = {
    lichess: string;
    chesscom: string;
};

export function normalizeChessUsername(value: string | null | undefined) {
    return (value ?? '')
        .trim()
        .toLocaleLowerCase('en-US')
        .replace(/\s+/g, ' ')
        .replace(/^@/, '');
}

export function getUserGameOutcome(args: {
    result: string | null;
    whiteName: string;
    blackName: string;
    userName: string;
}): UserGameOutcome {
    const userName = normalizeChessUsername(args.userName);
    if (!userName) return '?';

    const userIsWhite = userName === normalizeChessUsername(args.whiteName);
    const userIsBlack = userName === normalizeChessUsername(args.blackName);
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
    usernames: ProviderUsernames;
}): Prisma.AnalyzedGameWhereInput {
    const branches: Prisma.AnalyzedGameWhereInput[] = [];
    addProviderOutcomeBranches({
        branches,
        provider: 'LICHESS',
        username: args.usernames.lichess,
        result: args.result,
    });
    addProviderOutcomeBranches({
        branches,
        provider: 'CHESSCOM',
        username: args.usernames.chesscom,
        result: args.result,
    });

    return branches.length > 0 ? { OR: branches } : { id: { in: [] } };
}

export function buildOpponentSearchWhere(args: {
    query: string;
    usernames: ProviderUsernames;
}): Prisma.AnalyzedGameWhereInput {
    const query = args.query.trim();
    if (!query) return {};

    const branches: Prisma.AnalyzedGameWhereInput[] = [];
    addProviderOpponentBranches({
        branches,
        provider: 'LICHESS',
        username: args.usernames.lichess,
        query,
    });
    addProviderOpponentBranches({
        branches,
        provider: 'CHESSCOM',
        username: args.usernames.chesscom,
        query,
    });
    return branches.length > 0 ? { OR: branches } : { id: { in: [] } };
}

export function buildUserGameFiltersWhere(args: {
    result?: UserResultFilter | null;
    opponentQuery?: string;
    usernames: ProviderUsernames;
}): Prisma.AnalyzedGameWhereInput {
    const filters: Prisma.AnalyzedGameWhereInput[] = [];
    if (args.result) {
        filters.push(
            buildUserResultWhere({
                result: args.result,
                usernames: args.usernames,
            })
        );
    }
    if (args.opponentQuery?.trim()) {
        filters.push(
            buildOpponentSearchWhere({
                query: args.opponentQuery,
                usernames: args.usernames,
            })
        );
    }
    return filters.length > 0 ? { AND: filters } : {};
}

function addProviderOutcomeBranches(args: {
    branches: Prisma.AnalyzedGameWhereInput[];
    provider: Provider;
    username: string;
    result: UserResultFilter;
}) {
    const username = args.username.trim().replace(/^@/, '');
    if (!username) return;

    const whiteResult =
        args.result === 'draws'
            ? '1/2-1/2'
            : args.result === 'wins'
              ? '1-0'
              : '0-1';
    const blackResult =
        args.result === 'draws'
            ? '1/2-1/2'
            : args.result === 'wins'
              ? '0-1'
              : '1-0';
    args.branches.push(
        {
            provider: args.provider,
            whiteName: { equals: username, mode: 'insensitive' },
            result: whiteResult,
        },
        {
            provider: args.provider,
            blackName: { equals: username, mode: 'insensitive' },
            result: blackResult,
        }
    );
}

function addProviderOpponentBranches(args: {
    branches: Prisma.AnalyzedGameWhereInput[];
    provider: Provider;
    username: string;
    query: string;
}) {
    const username = args.username.trim().replace(/^@/, '');
    if (!username) return;

    args.branches.push(
        {
            provider: args.provider,
            whiteName: { equals: username, mode: 'insensitive' },
            blackName: { contains: args.query, mode: 'insensitive' },
        },
        {
            provider: args.provider,
            blackName: { equals: username, mode: 'insensitive' },
            whiteName: { contains: args.query, mode: 'insensitive' },
        }
    );
}
