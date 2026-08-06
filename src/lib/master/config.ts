import { serverAnalysisConfigFromPreferences } from '@/lib/services/analysisJobs';

export const WEEKLY_MASTER_SLOT_KEY = 'landing-weekly-master';
export const WEEKLY_MASTER_LEASE_MS = 5 * 60_000;
export const WEEKLY_MASTER_MAX_ATTEMPTS = 3;

export type WeeklyMasterRosterProvider = 'lichess' | 'chesscom';

export type WeeklyMasterRosterAccount = {
    provider: WeeklyMasterRosterProvider;
    username: string;
    active: boolean;
    priority: number;
    identityEvidence: {
        verifiedAt: string;
        profileState: 'active' | 'disabled';
        realName?: string;
        disclaimer: string;
    };
};

export type WeeklyMasterRosterEntry = {
    slug: string;
    displayName: string;
    attributionLabel: string;
    active: boolean;
    priority: number;
    accounts: readonly WeeklyMasterRosterAccount[];
};

const VERIFIED_AT = '2026-08-06T00:00:00.000Z';
const DISCLAIMER =
    'Public account attribution for source identification only; no endorsement is implied.';

function account(
    provider: WeeklyMasterRosterProvider,
    username: string,
    priority: number,
    realName: string,
    active = true
): WeeklyMasterRosterAccount {
    return {
        provider,
        username,
        active,
        priority,
        identityEvidence: {
            verifiedAt: VERIFIED_AT,
            profileState: active ? 'active' : 'disabled',
            realName,
            disclaimer: DISCLAIMER,
        },
    };
}

/**
 * Conservative built-in roster so a fresh deployment is autonomous. People
 * and their public playing accounts are separate records: adding a provider
 * never creates a Backranq user and never implies endorsement.
 */
export const DEFAULT_WEEKLY_MASTER_ROSTER: readonly WeeklyMasterRosterEntry[] = [
    {
        slug: 'magnus-carlsen',
        displayName: 'Magnus Carlsen',
        attributionLabel: 'Magnus Carlsen',
        active: true,
        priority: 100,
        accounts: [
            account('lichess', 'DrNykterstein', 100, 'Magnus Carlsen'),
            account('chesscom', 'magnuscarlsen', 99, 'Magnus Carlsen'),
        ],
    },
    {
        slug: 'hikaru-nakamura',
        displayName: 'Hikaru Nakamura',
        attributionLabel: 'Hikaru Nakamura',
        active: true,
        priority: 99,
        accounts: [account('chesscom', 'hikaru', 100, 'Hikaru Nakamura')],
    },
    {
        slug: 'levy-rozman',
        displayName: 'Levy Rozman',
        attributionLabel: 'Levy Rozman',
        active: true,
        priority: 94,
        accounts: [account('chesscom', 'gothamchess', 100, 'Levy Rozman')],
    },
    {
        slug: 'gukesh-dommaraju',
        displayName: 'Gukesh Dommaraju',
        attributionLabel: 'Gukesh Dommaraju',
        active: true,
        priority: 92,
        accounts: [
            account('chesscom', 'gukeshdommaraju', 100, 'Gukesh D'),
            // Retained as an explicitly disabled audit record: this Lichess
            // profile is a fan account, not identity evidence for Gukesh.
            account('lichess', 'GukeshD', 0, 'Unverified fan account', false),
        ],
    },
    {
        slug: 'fabiano-caruana',
        displayName: 'Fabiano Caruana',
        attributionLabel: 'Fabiano Caruana',
        active: true,
        priority: 90,
        accounts: [
            account('chesscom', 'fabianocaruana', 100, 'Fabiano Caruana'),
        ],
    },
    {
        slug: 'alireza-firouzja',
        displayName: 'Alireza Firouzja',
        attributionLabel: 'Alireza Firouzja',
        active: true,
        priority: 88,
        accounts: [
            account('lichess', 'alireza2003', 100, 'Alireza Firouzja'),
            account('chesscom', 'firouzja2003', 99, 'Alireza Firouzja'),
        ],
    },
    {
        slug: 'anish-giri',
        displayName: 'Anish Giri',
        attributionLabel: 'Anish Giri',
        active: true,
        priority: 86,
        accounts: [
            account('lichess', 'AnishGiri', 100, 'Anish Giri'),
            account('chesscom', 'anishgiri', 99, 'Anish Giri'),
        ],
    },
    {
        slug: 'alexandra-botez',
        displayName: 'Alexandra Botez',
        attributionLabel: 'Alexandra Botez',
        active: true,
        priority: 82,
        accounts: [
            account('chesscom', 'alexandrabotez', 100, 'Alexandra Botez'),
            account('lichess', 'AlexandraBotez', 0, 'Alexandra Botez', false),
        ],
    },
    {
        slug: 'anna-cramling',
        displayName: 'Anna Cramling',
        attributionLabel: 'Anna Cramling',
        active: true,
        priority: 80,
        accounts: [account('chesscom', 'annacramling', 100, 'Anna Cramling')],
    },
    {
        slug: 'eric-rosen',
        displayName: 'Eric Rosen',
        attributionLabel: 'Eric Rosen',
        active: true,
        priority: 78,
        accounts: [
            account('lichess', 'EricRosen', 100, 'Eric Rosen'),
            account('chesscom', 'imrosen', 99, 'Eric Rosen'),
        ],
    },
] as const;

export function weeklyMasterConfig() {
    const analysis = serverAnalysisConfigFromPreferences(undefined, {
        analysisQuality: 'STANDARD',
        trainingCoveragePreset: 'ALL_CONFIRMED',
        trainingGradingTolerance: 'PRACTICAL',
    });
    return {
        version: 2 as const,
        source: {
            providers: ['lichess', 'chesscom'] as const,
            lookbackDays: 21,
            maxGamesPerAccount: 12,
            maxAccountsPerRun: 14,
        },
        analysis: {
            // One full Stockfish extraction keeps a queue delivery comfortably
            // within the 300 second visibility window. Daily runs rotate across
            // people and providers, accumulating candidates for joint ranking.
            maxSnapshotsPerRun: 1,
            snapshot: analysis.config.snapshot,
            configHash: analysis.config.hash,
            options: analysis.options,
        },
        publication: {
            minimumScore: 62,
            freshForDays: 10,
            maxStaleDays: 35,
        },
    };
}
