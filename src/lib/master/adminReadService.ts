import { isRecord } from '@/lib/api/validation';
import { prisma } from '@/lib/prisma';
import type { WeeklyMasterAdminSnapshot } from '@/lib/master/adminContracts';
import { WEEKLY_MASTER_SLOT_KEY } from '@/lib/master/config';

const ADMIN_PAGE_LIMIT = 50;
const ONBOARDING_FUNNEL_WINDOW_DAYS = 7;

function iso(value: Date | null | undefined): string | null {
    return value ? value.toISOString() : null;
}

function evidenceSummary(args: {
    evidence: unknown;
    cpLoss: number | null;
    winChanceLoss: number | null;
    verificationStatus: string;
}): string {
    const parts: string[] = [args.verificationStatus.replaceAll('_', ' ')];
    if (args.cpLoss !== null) parts.push(`${Math.round(args.cpLoss)} cp loss`);
    if (args.winChanceLoss !== null) {
        parts.push(`${Math.round(args.winChanceLoss * 100)}% win-chance loss`);
    }
    if (isRecord(args.evidence)) {
        const depth = args.evidence.depth;
        if (typeof depth === 'number') parts.push(`depth ${Math.round(depth)}`);
    }
    return parts.join(' · ');
}

function percentile(sorted: number[], fraction: number): number | null {
    if (sorted.length === 0) return null;
    const index = Math.min(
        sorted.length - 1,
        Math.max(0, Math.ceil(sorted.length * fraction) - 1)
    );
    return sorted[index] ?? null;
}

export async function getWeeklyMasterAdminSnapshot(
    now = new Date()
): Promise<WeeklyMasterAdminSnapshot> {
    const activeOverrideWhere = {
        revokedAt: null,
        startsAt: { lte: now },
        expiresAt: { gt: now },
    } as const;

    const [
        latestRuns,
        people,
        sourceGames,
        candidates,
        publications,
        activeOverrides,
        slot,
        userCount,
        linkedAccountCount,
        sourceGameCount,
        eligibleCandidateCount,
        publishedPuzzleCount,
        failedRunCount,
        recentUsers,
        onboardingCounts,
        readinessDurations,
    ] = await Promise.all([
        prisma.masterPipelineRun.findMany({
            orderBy: { createdAt: 'desc' },
            take: 12,
            select: {
                id: true,
                runKey: true,
                status: true,
                stage: true,
                trigger: true,
                scheduledFor: true,
                startedAt: true,
                completedAt: true,
                lastError: true,
                attempts: true,
            },
        }),
        prisma.masterPerson.findMany({
            orderBy: [{ priority: 'desc' }, { displayName: 'asc' }],
            take: ADMIN_PAGE_LIMIT,
            select: {
                id: true,
                displayName: true,
                attributionLabel: true,
                priority: true,
                active: true,
                accounts: {
                    orderBy: [{ priority: 'desc' }, { provider: 'asc' }],
                    select: {
                        id: true,
                        provider: true,
                        username: true,
                        profileUrl: true,
                        active: true,
                        identityVerifiedAt: true,
                        lastSuccessAt: true,
                        lastError: true,
                    },
                },
            },
        }),
        prisma.masterSourceGame.findMany({
            orderBy: { lastSeenAt: 'desc' },
            take: ADMIN_PAGE_LIMIT,
            select: {
                id: true,
                provider: true,
                externalId: true,
                canonicalUrl: true,
                availability: true,
                lastSeenAt: true,
                discoveries: {
                    orderBy: { lastSeenAt: 'desc' },
                    take: 1,
                    select: {
                        account: {
                            select: {
                                person: {
                                    select: { attributionLabel: true },
                                },
                            },
                        },
                    },
                },
                currentSnapshot: {
                    select: {
                        sourceUrl: true,
                        playedAt: true,
                        whiteName: true,
                        blackName: true,
                    },
                },
            },
        }),
        prisma.masterCandidate.findMany({
            orderBy: [{ totalScore: 'desc' }, { createdAt: 'desc' }],
            take: ADMIN_PAGE_LIMIT,
            select: {
                id: true,
                decisionPly: true,
                fen: true,
                originalMoveUci: true,
                bestMoveUci: true,
                totalScore: true,
                status: true,
                hardGatePassed: true,
                rejectionReasons: true,
                evidence: true,
                cpLoss: true,
                winChanceLoss: true,
                verificationStatus: true,
                person: { select: { attributionLabel: true } },
                publication: { select: { id: true } },
                snapshot: {
                    select: {
                        sourceGameId: true,
                        sourceUrl: true,
                        sourceGame: { select: { canonicalUrl: true } },
                    },
                },
            },
        }),
        prisma.masterPublication.findMany({
            orderBy: { publishedAt: 'desc' },
            take: ADMIN_PAGE_LIMIT,
            select: {
                id: true,
                slug: true,
                candidateId: true,
                headline: true,
                attributionLabel: true,
                status: true,
                health: true,
                sourceUrl: true,
                isFallback: true,
                publishedAt: true,
                staleSince: true,
            },
        }),
        prisma.masterAdminOverride.findMany({
            where: activeOverrideWhere,
            select: {
                id: true,
                kind: true,
                personId: true,
                accountId: true,
                reason: true,
                expiresAt: true,
                slot: { select: { key: true } },
                person: { select: { displayName: true } },
                account: {
                    select: { provider: true, username: true },
                },
                publication: { select: { headline: true } },
                targetPublication: { select: { headline: true } },
            },
        }),
        prisma.masterSlot.findUnique({
            where: { key: WEEKLY_MASTER_SLOT_KEY },
            select: {
                key: true,
                currentPublicationId: true,
                fallbackPublicationId: true,
            },
        }),
        prisma.user.count(),
        prisma.user.count({
            where: {
                OR: [
                    { lichessUsername: { not: null } },
                    { chesscomUsername: { not: null } },
                ],
            },
        }),
        prisma.masterSourceGame.count(),
        prisma.masterCandidate.count({
            where: { status: 'ELIGIBLE', hardGatePassed: true },
        }),
        prisma.masterPublication.count({ where: { status: 'PUBLISHED' } }),
        prisma.masterPipelineRun.count({ where: { status: 'FAILED' } }),
        prisma.user.findMany({
            orderBy: { createdAt: 'desc' },
            take: 25,
            select: {
                id: true,
                name: true,
                createdAt: true,
                lichessUsername: true,
                chesscomUsername: true,
                _count: { select: { games: true } },
                games: {
                    where: { analyzedAt: { not: null } },
                    orderBy: { analyzedAt: 'desc' },
                    take: 1,
                    select: { analyzedAt: true },
                },
            },
        }),
        prisma.onboardingAnalyticsEvent.groupBy({
            by: ['eventName'],
            where: {
                occurredAt: {
                    gte: new Date(
                        now.getTime() -
                            ONBOARDING_FUNNEL_WINDOW_DAYS * 86_400_000
                    ),
                },
            },
            _count: { _all: true },
        }),
        prisma.onboardingAnalyticsEvent.findMany({
            where: {
                eventName: 'PERSONAL_PUZZLE_READY',
                occurredAt: {
                    gte: new Date(
                        now.getTime() -
                            ONBOARDING_FUNNEL_WINDOW_DAYS * 86_400_000
                    ),
                },
                durationMs: { not: null },
            },
            orderBy: { occurredAt: 'desc' },
            take: 5_000,
            select: { durationMs: true },
        }),
    ]);

    const personExclusions = new Map<string, Date>();
    const accountExclusions = new Map<string, Date>();
    for (const override of activeOverrides) {
        if (override.kind === 'EXCLUDE_PERSON' && override.personId) {
            personExclusions.set(override.personId, override.expiresAt);
        }
        if (override.kind === 'EXCLUDE_ACCOUNT' && override.accountId) {
            accountExclusions.set(override.accountId, override.expiresAt);
        }
    }
    const pause = activeOverrides
        .filter((override) => override.kind === 'PAUSE_AUTOMATION')
        .sort((a, b) => b.expiresAt.getTime() - a.expiresAt.getTime())[0];
    const eventCounts = new Map(
        onboardingCounts.map((row) => [String(row.eventName), row._count._all])
    );
    const count = (name: string) => eventCounts.get(name) ?? 0;
    const durationValues = readinessDurations
        .flatMap((row) =>
            typeof row.durationMs === 'number' ? [row.durationMs] : []
        )
        .sort((a, b) => a - b);
    const submitted = count('IDENTITY_SUBMITTED');
    const personalStarted = count('PERSONAL_ATTEMPT_STARTED');

    return {
        generatedAt: now.toISOString(),
        automation: {
            mode: pause ? 'PAUSED' : 'AUTONOMOUS',
            pausedUntil: iso(pause?.expiresAt),
            activeOverrideCount: activeOverrides.length,
            currentSlotKey: slot?.key ?? null,
            currentPublicationId: slot?.currentPublicationId ?? null,
            fallbackPublicationId: slot?.fallbackPublicationId ?? null,
        },
        stats: {
            users: userCount,
            linkedAccounts: linkedAccountCount,
            sourceGames: sourceGameCount,
            eligibleCandidates: eligibleCandidateCount,
            publishedPuzzles: publishedPuzzleCount,
            failedRuns: failedRunCount,
        },
        onboardingFunnel: {
            windowDays: ONBOARDING_FUNNEL_WINDOW_DAYS,
            landingViewed: count('LANDING_VIEWED'),
            identitySubmitted: submitted,
            lookupSucceeded: count('IDENTITY_LOOKUP_SUCCEEDED'),
            analysisStarted: count('PERSONAL_ANALYSIS_STARTED'),
            analysisFailed: count('PERSONAL_ANALYSIS_FAILED'),
            personalReady: count('PERSONAL_PUZZLE_READY'),
            masterTerminal: count('MASTER_ATTEMPT_TERMINAL'),
            handoffClicked: count('PERSONAL_HANDOFF_CLICKED'),
            personalStarted,
            personalTerminal: count('PERSONAL_ATTEMPT_TERMINAL'),
            activationRate:
                submitted > 0
                    ? Math.min(1, personalStarted / submitted)
                    : null,
            readinessMedianMs: percentile(durationValues, 0.5),
            readinessP90Ms: percentile(durationValues, 0.9),
        },
        activeOverrides: activeOverrides.map((override) => ({
            id: override.id,
            kind: String(override.kind),
            targetLabel:
                override.person?.displayName ??
                (override.account
                    ? `${override.account.provider} · ${override.account.username}`
                    : null) ??
                override.targetPublication?.headline ??
                override.publication?.headline ??
                override.slot?.key ??
                'Weekly Master pipeline',
            expiresAt: override.expiresAt.toISOString(),
            reason: override.reason,
        })),
        latestRuns: latestRuns.map((run) => ({
            ...run,
            scheduledFor: run.scheduledFor.toISOString(),
            startedAt: iso(run.startedAt),
            completedAt: iso(run.completedAt),
        })),
        roster: people.map((person) => ({
            ...person,
            excludedUntil: iso(personExclusions.get(person.id)),
            accounts: person.accounts.map((account) => ({
                ...account,
                provider: String(account.provider),
                identityVerifiedAt: iso(account.identityVerifiedAt),
                lastSuccessAt: iso(account.lastSuccessAt),
                excludedUntil: iso(accountExclusions.get(account.id)),
            })),
        })),
        sourceGames: sourceGames.map((game) => ({
            id: game.id,
            personLabel:
                game.discoveries[0]?.account.person.attributionLabel ??
                'Unknown source',
            provider: String(game.provider),
            externalId: game.externalId,
            canonicalUrl:
                game.canonicalUrl ?? game.currentSnapshot?.sourceUrl ?? '',
            availability: String(game.availability),
            playedAt: iso(game.currentSnapshot?.playedAt),
            matchup: game.currentSnapshot
                ? `${game.currentSnapshot.whiteName} – ${game.currentSnapshot.blackName}`
                : null,
            lastSeenAt: game.lastSeenAt.toISOString(),
        })),
        candidates: candidates.map((candidate) => ({
            id: candidate.id,
            personLabel: candidate.person.attributionLabel,
            sourceGameId: candidate.snapshot.sourceGameId,
            sourceUrl:
                candidate.snapshot.sourceUrl ??
                candidate.snapshot.sourceGame.canonicalUrl ??
                '',
            decisionPly: candidate.decisionPly,
            fen: candidate.fen,
            originalMoveUci: candidate.originalMoveUci,
            bestMoveUci: candidate.bestMoveUci,
            score: candidate.totalScore,
            status: String(candidate.status),
            hardGatePassed: candidate.hardGatePassed,
            rejectionReasons: candidate.rejectionReasons,
            evidenceSummary: evidenceSummary(candidate),
            publicationId: candidate.publication?.id ?? null,
        })),
        publications: publications.map((publication) => ({
            id: publication.id,
            slug: publication.slug,
            candidateId: publication.candidateId,
            headline: publication.headline,
            attribution: publication.attributionLabel,
            status: String(publication.status),
            health: String(publication.health),
            sourceUrl: publication.sourceUrl ?? '',
            isFallback: publication.isFallback,
            publishedAt: iso(publication.publishedAt),
            staleAt: iso(publication.staleSince),
        })),
        recentUsers: recentUsers.map((user) => ({
            id: user.id,
            displayName: user.name?.trim() || `User ${user.id.slice(0, 8)}`,
            createdAt: user.createdAt.toISOString(),
            linkedProviders: [
                ...(user.lichessUsername ? ['Lichess'] : []),
                ...(user.chesscomUsername ? ['Chess.com'] : []),
            ],
            gameCount: user._count.games,
            lastAnalysisAt: iso(user.games[0]?.analyzedAt),
        })),
    };
}
