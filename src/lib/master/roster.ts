import type { MasterAccount, MasterPerson, Prisma, Provider } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import {
    DEFAULT_WEEKLY_MASTER_ROSTER,
    type WeeklyMasterRosterProvider,
} from '@/lib/master/config';

type RosterClient = Pick<
    Prisma.TransactionClient,
    'masterPerson' | 'masterAccount'
>;

export type MasterAccountWithPerson = MasterAccount & { person: MasterPerson };

function dbProvider(provider: WeeklyMasterRosterProvider): Provider {
    return provider === 'lichess' ? 'LICHESS' : 'CHESSCOM';
}

function profileUrl(provider: WeeklyMasterRosterProvider, username: string) {
    return provider === 'lichess'
        ? `https://lichess.org/@/${encodeURIComponent(username)}`
        : `https://www.chess.com/member/${encodeURIComponent(username)}`;
}

export async function ensureDefaultMasterRoster(
    client: RosterClient = prisma
) {
    const accounts: MasterAccountWithPerson[] = [];
    for (const entry of DEFAULT_WEEKLY_MASTER_ROSTER) {
        const person = await client.masterPerson.upsert({
            where: { slug: entry.slug },
            create: {
                slug: entry.slug,
                displayName: entry.displayName,
                attributionLabel: entry.attributionLabel,
                active: entry.active,
                priority: entry.priority,
            },
            update: {
                displayName: entry.displayName,
                attributionLabel: entry.attributionLabel,
                active: entry.active,
                priority: entry.priority,
            },
        });
        for (const rosterAccount of entry.accounts) {
            const provider = dbProvider(rosterAccount.provider);
            const usernameNormalized = rosterAccount.username.toLocaleLowerCase('en-US');
            const canonicalProfileUrl = profileUrl(
                rosterAccount.provider,
                rosterAccount.username
            );
            const identityEvidence = {
                ...rosterAccount.identityEvidence,
                provider: rosterAccount.provider,
                profileUrl: canonicalProfileUrl,
                method:
                    rosterAccount.identityEvidence.profileState === 'active'
                        ? 'manual primary-profile verification'
                        : 'manual primary-profile rejection',
            } as unknown as Prisma.InputJsonValue;
            accounts.push(
                await client.masterAccount.upsert({
                    where: {
                        provider_usernameNormalized: {
                            provider,
                            usernameNormalized,
                        },
                    },
                    create: {
                        personId: person.id,
                        provider,
                        username: rosterAccount.username,
                        usernameNormalized,
                        profileUrl: canonicalProfileUrl,
                        identityEvidence,
                        identityVerifiedAt: new Date(
                            rosterAccount.identityEvidence.verifiedAt
                        ),
                        active: rosterAccount.active,
                        priority: rosterAccount.priority,
                    },
                    update: {
                        personId: person.id,
                        username: rosterAccount.username,
                        profileUrl: canonicalProfileUrl,
                        identityEvidence,
                        identityVerifiedAt: new Date(
                            rosterAccount.identityEvidence.verifiedAt
                        ),
                        active: rosterAccount.active,
                        priority: rosterAccount.priority,
                    },
                    include: { person: true },
                })
            );
        }
    }
    return accounts;
}

/**
 * Rotates the first analysis chance across people every day and, on later
 * cycles, across that person's providers. Source fetching still covers every
 * active account; this only prevents one prolific account from monopolising
 * the bounded Stockfish slot.
 */
export function orderMasterAccountsForAnalysis(
    accounts: readonly MasterAccountWithPerson[],
    now: Date
) {
    const groups = new Map<string, MasterAccountWithPerson[]>();
    for (const account of accounts) {
        const group = groups.get(account.personId) ?? [];
        group.push(account);
        groups.set(account.personId, group);
    }
    const people = [...groups.values()]
        .map((group) =>
            group.sort(
                (left, right) =>
                    right.priority - left.priority ||
                    left.provider.localeCompare(right.provider) ||
                    left.username.localeCompare(right.username)
            )
        )
        .sort(
            (left, right) =>
                right[0]!.person.priority - left[0]!.person.priority ||
                left[0]!.person.slug.localeCompare(right[0]!.person.slug)
        );
    if (people.length === 0) return [];

    const utcDay = Math.floor(now.getTime() / 86_400_000);
    const personOffset = utcDay % people.length;
    const providerCycle = Math.floor(utcDay / people.length);
    const rotatedPeople = [
        ...people.slice(personOffset),
        ...people.slice(0, personOffset),
    ];
    return rotatedPeople.flatMap((group) => {
        const providerOffset = providerCycle % group.length;
        return [
            ...group.slice(providerOffset),
            ...group.slice(0, providerOffset),
        ];
    });
}
