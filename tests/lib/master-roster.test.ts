import { describe, expect, it } from 'vitest';
import type { MasterAccountWithPerson } from '@/lib/master/roster';
import {
    DEFAULT_WEEKLY_MASTER_ROSTER,
    weeklyMasterConfig,
} from '@/lib/master/config';
import { orderMasterAccountsForAnalysis } from '@/lib/master/roster';

describe('Weekly Master multi-provider roster', () => {
    it('covers the ten-person watchlist with verified Chess.com accounts', () => {
        expect(DEFAULT_WEEKLY_MASTER_ROSTER).toHaveLength(10);
        const chessComUsernames = DEFAULT_WEEKLY_MASTER_ROSTER.flatMap(
            (person) =>
                person.accounts
                    .filter(
                        (account) =>
                            account.provider === 'chesscom' && account.active
                    )
                    .map((account) => account.username)
        );

        expect(chessComUsernames).toEqual([
            'magnuscarlsen',
            'hikaru',
            'gothamchess',
            'gukeshdommaraju',
            'fabianocaruana',
            'firouzja2003',
            'anishgiri',
            'alexandrabotez',
            'annacramling',
            'imrosen',
        ]);
        expect(weeklyMasterConfig().source.providers).toEqual([
            'lichess',
            'chesscom',
        ]);
    });

    it('keeps misleading lookalike accounts out of autonomous fetching', () => {
        const accounts = DEFAULT_WEEKLY_MASTER_ROSTER.flatMap(
            (person) => person.accounts
        );
        expect(
            accounts.find(
                (account) =>
                    account.provider === 'lichess' &&
                    account.username === 'GukeshD'
            )?.active
        ).toBe(false);
        expect(
            accounts.some(
                (account) =>
                    account.provider === 'chesscom' &&
                    ['gukeshd', 'alireza2003', 'ericrosen'].includes(
                        account.username
                    ) &&
                    account.active
            )
        ).toBe(false);
    });

    it('rotates the bounded analysis slot across people and their providers', () => {
        const person = {
            id: 'person-a',
            slug: 'person-a',
            displayName: 'Person A',
            attributionLabel: 'Person A',
            active: true,
            priority: 100,
        };
        const otherPerson = {
            ...person,
            id: 'person-b',
            slug: 'person-b',
            displayName: 'Person B',
            attributionLabel: 'Person B',
            priority: 90,
        };
        const accounts = [
            {
                id: 'lichess-a',
                personId: person.id,
                provider: 'LICHESS',
                username: 'person-a',
                priority: 100,
                person,
            },
            {
                id: 'chesscom-a',
                personId: person.id,
                provider: 'CHESSCOM',
                username: 'person-a',
                priority: 99,
                person,
            },
            {
                id: 'chesscom-b',
                personId: otherPerson.id,
                provider: 'CHESSCOM',
                username: 'person-b',
                priority: 100,
                person: otherPerson,
            },
        ] as unknown as MasterAccountWithPerson[];

        const dayZero = new Date('1970-01-01T12:00:00.000Z');
        const dayOne = new Date('1970-01-02T12:00:00.000Z');
        const nextProviderCycle = new Date('1970-01-03T12:00:00.000Z');

        expect(orderMasterAccountsForAnalysis(accounts, dayZero)[0]?.personId).toBe(
            'person-a'
        );
        expect(orderMasterAccountsForAnalysis(accounts, dayOne)[0]?.personId).toBe(
            'person-b'
        );
        expect(
            orderMasterAccountsForAnalysis(accounts, dayZero)
                .filter((account) => account.personId === 'person-a')
                .map((account) => account.id)
        ).toEqual(['lichess-a', 'chesscom-a']);
        expect(
            orderMasterAccountsForAnalysis(accounts, nextProviderCycle)
                .filter((account) => account.personId === 'person-a')
                .map((account) => account.id)
        ).toEqual(['chesscom-a', 'lichess-a']);
    });
});
