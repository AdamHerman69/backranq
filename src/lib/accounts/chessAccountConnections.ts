import type { SyncProvider } from '@prisma/client';

export type ChessAccountConnectionSnapshot = {
    provider: SyncProvider;
    providerAccountId?: string | null;
    username: string;
    usernameNormalized: string;
};

export const chessAccountConnectionSelect = {
    provider: true,
    providerAccountId: true,
    username: true,
    usernameNormalized: true,
} as const;

export function connectionForProvider(
    connections: readonly ChessAccountConnectionSnapshot[],
    provider: SyncProvider
) {
    return connections.find((connection) => connection.provider === provider) ?? null;
}

export function usernameForProvider(
    connections: readonly ChessAccountConnectionSnapshot[],
    provider: SyncProvider
) {
    return connectionForProvider(connections, provider)?.username ?? null;
}

export function linkedUsernameSnapshot(
    connections: readonly ChessAccountConnectionSnapshot[]
) {
    return {
        lichessUsername: usernameForProvider(connections, 'LICHESS'),
        chesscomUsername: usernameForProvider(connections, 'CHESSCOM'),
    };
}
