import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MasterAccount } from '@prisma/client';
import { MasterSourceProviderError } from '@/lib/master/sourceErrors';

const { chessComFetchMock, lichessFetchMock, accountUpdateMock } = vi.hoisted(
    () => ({
        chessComFetchMock: vi.fn(),
        lichessFetchMock: vi.fn(),
        accountUpdateMock: vi.fn(),
    })
);

vi.mock('@/lib/providers/chesscom', () => ({
    fetchChessComGames: chessComFetchMock,
}));
vi.mock('@/lib/providers/lichess', () => ({
    fetchLichessGames: lichessFetchMock,
}));
vi.mock('@/lib/prisma', () => ({
    prisma: {
        masterAccount: { update: accountUpdateMock },
    },
}));

import { fetchAndPersistMasterAccount } from '@/lib/master/source';

function account(provider: 'LICHESS' | 'CHESSCOM') {
    return {
        id: `account-${provider}`,
        provider,
        username: provider === 'CHESSCOM' ? 'hikaru' : 'DrNykterstein',
    } as MasterAccount;
}

describe('Weekly Master source importer', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        chessComFetchMock.mockResolvedValue({ games: [], etag: 'chess-etag' });
        lichessFetchMock.mockResolvedValue({ games: [], etag: 'lichess-etag' });
        accountUpdateMock.mockResolvedValue({});
    });

    it('uses Chess.com archives for Chess.com master accounts', async () => {
        await fetchAndPersistMasterAccount({
            account: account('CHESSCOM'),
            pipelineRunId: 'run-1',
            since: new Date('2026-07-15T00:00:00.000Z'),
            maxGames: 12,
            now: new Date('2026-08-06T00:00:00.000Z'),
        });

        expect(chessComFetchMock).toHaveBeenCalledWith(
            expect.objectContaining({
                username: 'hikaru',
                filters: expect.objectContaining({ max: 12 }),
            })
        );
        expect(lichessFetchMock).not.toHaveBeenCalled();
        expect(accountUpdateMock).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: 'account-CHESSCOM' },
                data: expect.objectContaining({ etag: 'chess-etag' }),
            })
        );
    });

    it('keeps the existing Lichess importer for Lichess master accounts', async () => {
        await fetchAndPersistMasterAccount({
            account: account('LICHESS'),
            pipelineRunId: 'run-2',
            since: new Date('2026-07-15T00:00:00.000Z'),
            maxGames: 12,
            now: new Date('2026-08-06T00:00:00.000Z'),
        });

        expect(lichessFetchMock).toHaveBeenCalledWith(
            expect.objectContaining({ username: 'DrNykterstein' })
        );
        expect(chessComFetchMock).not.toHaveBeenCalled();
    });

    it('types an upstream provider failure only after recording it', async () => {
        chessComFetchMock.mockRejectedValue(new Error('provider unavailable'));

        const error = await fetchAndPersistMasterAccount({
            account: account('CHESSCOM'),
            pipelineRunId: 'run-3',
            since: new Date('2026-07-15T00:00:00.000Z'),
            maxGames: 12,
            now: new Date('2026-08-06T00:00:00.000Z'),
        }).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(MasterSourceProviderError);
        expect(accountUpdateMock).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    consecutiveFailures: { increment: 1 },
                    lastError: 'provider unavailable',
                }),
            })
        );
    });

    it('does not disguise a database failure while recording provider health', async () => {
        chessComFetchMock.mockRejectedValue(new Error('provider unavailable'));
        accountUpdateMock.mockRejectedValue(
            new Error('database connection unavailable')
        );

        const error = await fetchAndPersistMasterAccount({
            account: account('CHESSCOM'),
            pipelineRunId: 'run-4',
            since: new Date('2026-07-15T00:00:00.000Z'),
            maxGames: 12,
            now: new Date('2026-08-06T00:00:00.000Z'),
        }).catch((caught: unknown) => caught);

        expect(error).toEqual(new Error('database connection unavailable'));
        expect(error).not.toBeInstanceOf(MasterSourceProviderError);
    });
});
