import { Prisma } from '@prisma/client';
import type { TrainingPromptDto } from '@/lib/training/api';
import { toTrainingPromptDto } from '@/lib/training/apiMappers';
import { prisma } from '@/lib/prisma';
import {
    WEEKLY_MASTER_SLOT_KEY,
    weeklyMasterConfig,
} from '@/lib/master/config';
import { masterContentHash } from '@/lib/master/ranking';

type PublicationClient = Pick<
    Prisma.TransactionClient,
    | 'masterCandidate'
    | 'masterPublication'
    | 'masterSlot'
    | 'masterAdminOverride'
>;

const candidateInclude = {
    person: true,
    account: true,
    snapshot: { include: { sourceGame: true } },
    publication: true,
} satisfies Prisma.MasterCandidateInclude;

type PublicationCandidate = Prisma.MasterCandidateGetPayload<{
    include: typeof candidateInclude;
}>;

function moveAssessments(value: Prisma.JsonValue) {
    if (!Array.isArray(value)) return [];
    return value
        .filter(
            (item): item is Prisma.JsonObject =>
                item != null && typeof item === 'object' && !Array.isArray(item)
        )
        .map((item) => ({
            decisionIndex:
                typeof item.decisionIndex === 'number'
                    ? item.decisionIndex
                    : 0,
            fen: typeof item.fen === 'string' ? item.fen : '',
            moveUci:
                typeof item.moveUci === 'string' ? item.moveUci : '',
            source:
                item.source === 'TABLEBASE'
                    ? ('TABLEBASE' as const)
                    : ('PRECOMPUTED' as const),
            status: 'VERIFIED' as const,
            grade:
                item.grade === 'GOOD'
                    ? ('GOOD' as const)
                    : item.grade === 'STRONG'
                      ? ('STRONG' as const)
                      : ('BEST' as const),
            scoreAfter: item.scoreAfter ?? null,
            evidence: item.evidence ?? null,
        }))
        .filter((item) => item.fen && item.moveUci);
}

export function masterCandidateToTrainingPrompt(
    candidate: PublicationCandidate
): TrainingPromptDto {
    return toTrainingPromptDto({
        id: candidate.id,
        currentSolutionRevisionId: candidate.id,
        fen: candidate.fen,
        sideToMove: candidate.sideToMove,
        positionHistory: candidate.positionHistory,
        originalMoveUci: candidate.originalMoveUci,
        scoreBefore: candidate.scoreBefore,
        scoreAfter: candidate.scoreAfter,
        cpLoss: candidate.cpLoss,
        winChanceLoss: candidate.winChanceLoss,
        sourceKinds: candidate.sourceKinds,
        lessonKinds: candidate.lessonKinds,
        themes: candidate.themes,
        gameId: candidate.snapshot.sourceGameId,
        decisionPly: candidate.decisionPly,
        game: {
            provider: candidate.snapshot.sourceGame.provider,
            playedAt: candidate.snapshot.playedAt,
        },
        currentSolutionRevision: {
            bestMoveUci: candidate.bestMoveUci,
            acceptedMovesUci: candidate.acceptedMovesUci,
            acceptanceFrontier: candidate.acceptanceFrontier,
            solutionShape: candidate.solutionShape,
            bestLine: candidate.bestLine,
            scoreAtStart: candidate.scoreAtStart,
            gradingPolicy: candidate.gradingPolicy,
            solutionTree: candidate.solutionTree,
            moveAssessments: moveAssessments(candidate.moveAssessments),
        },
    });
}

function publicationCopy(candidate: PublicationCandidate) {
    const prompt = masterCandidateToTrainingPrompt(candidate);
    const side = candidate.sideToMove === 'w' ? 'White' : 'Black';
    const headline = `A position from ${candidate.person.attributionLabel}'s public game`;
    const teaser = `${side} to move. Can you find the best continuation?`;
    const reviewPayload = {
        sourceUrl: candidate.snapshot.sourceUrl,
        sourceGameId: candidate.snapshot.sourceGameId,
        provider: candidate.snapshot.sourceGame.provider,
        playedAt: candidate.snapshot.playedAt.toISOString(),
        players: {
            white: {
                name: candidate.snapshot.whiteName,
                rating: candidate.snapshot.whiteRating,
            },
            black: {
                name: candidate.snapshot.blackName,
                rating: candidate.snapshot.blackRating,
            },
        },
        attribution: {
            label: candidate.person.attributionLabel,
            profileUrl: candidate.account.profileUrl,
            disclaimer:
                'Public game attribution only; no endorsement or affiliation is implied.',
        },
    };
    return {
        prompt,
        headline,
        teaser,
        reviewPayload,
        contentHash: masterContentHash({
            version: 1,
            candidateId: candidate.id,
            prompt,
            reviewPayload,
            headline,
            teaser,
        }),
    };
}

export async function publishMasterCandidate(
    tx: PublicationClient,
    args: {
        candidateId: string;
        slotKey?: string;
        now?: Date;
        isFallback?: boolean;
    }
) {
    const now = args.now ?? new Date();
    const candidate = await tx.masterCandidate.findUnique({
        where: { id: args.candidateId },
        include: candidateInclude,
    });
    if (!candidate || !candidate.hardGatePassed) {
        throw new Error('Master candidate is not publishable');
    }
    const copy = publicationCopy(candidate);
    const date = candidate.snapshot.playedAt.toISOString().slice(0, 10);
    const slug = `${date}-${candidate.person.slug}-${candidate.id.slice(0, 8)}`;
    const publication =
        candidate.publication ??
        (await tx.masterPublication.create({
            data: {
                slug,
                candidateId: candidate.id,
                headline: copy.headline,
                teaser: copy.teaser,
                attributionLabel: candidate.person.attributionLabel,
                promptPayload: copy.prompt as unknown as Prisma.InputJsonValue,
                reviewPayload:
                    copy.reviewPayload as unknown as Prisma.InputJsonValue,
                sourceUrl: candidate.snapshot.sourceUrl,
                contentHash: copy.contentHash,
                isFallback: args.isFallback ?? false,
                publishedAt: now,
                lastCheckedAt: now,
            },
        }));

    await tx.masterCandidate.update({
        where: { id: candidate.id },
        data: { status: 'PUBLISHED' },
    });
    if (args.slotKey) {
        const slot = await tx.masterSlot.upsert({
            where: { key: args.slotKey },
            create: { key: args.slotKey },
            update: {},
        });
        const nextFallbackPublicationId =
            slot.currentPublicationId &&
            slot.currentPublicationId !== publication.id
                ? slot.currentPublicationId
                : (slot.fallbackPublicationId ?? publication.id);
        await tx.masterPublication.updateMany({
            where: {
                id: {
                    in: [
                        publication.id,
                        ...(slot.fallbackPublicationId
                            ? [slot.fallbackPublicationId]
                            : []),
                        ...(slot.currentPublicationId
                            ? [slot.currentPublicationId]
                            : []),
                    ],
                },
            },
            data: { isFallback: false },
        });
        await tx.masterPublication.update({
            where: { id: nextFallbackPublicationId },
            data: { isFallback: true },
        });
        await tx.masterSlot.update({
            where: { id: slot.id },
            data: {
                currentPublicationId: publication.id,
                fallbackPublicationId: nextFallbackPublicationId,
                version: { increment: 1 },
                resolvedAt: now,
            },
        });
    }
    return publication;
}

export async function publishBestMasterCandidate(args: {
    pipelineRunId: string;
    now?: Date;
}) {
    const now = args.now ?? new Date();
    const config = weeklyMasterConfig();
    const slot = await prisma.masterSlot.upsert({
        where: { key: WEEKLY_MASTER_SLOT_KEY },
        create: { key: WEEKLY_MASTER_SLOT_KEY },
        update: {},
    });
    if (
        slot.currentPublicationId &&
        (await currentPublicationIsThisWeek(slot.currentPublicationId, now))
    ) {
        return null;
    }
    const activeOverrides = await prisma.masterAdminOverride.findMany({
        where: {
            revokedAt: null,
            startsAt: { lte: now },
            expiresAt: { gt: now },
            kind: {
                in: ['PAUSE_AUTOMATION', 'EXCLUDE_PERSON', 'EXCLUDE_ACCOUNT'],
            },
            OR: [
                { slotId: slot.id },
                { personId: { not: null } },
                { accountId: { not: null } },
            ],
        },
    });
    if (
        activeOverrides.some(
            (override) =>
                override.kind === 'PAUSE_AUTOMATION' &&
                override.slotId === slot.id
        )
    ) {
        return null;
    }
    const excludedPersonIds = activeOverrides.flatMap((override) =>
        override.kind === 'EXCLUDE_PERSON' && override.personId
            ? [override.personId]
            : []
    );
    const excludedAccountIds = activeOverrides.flatMap((override) =>
        override.kind === 'EXCLUDE_ACCOUNT' && override.accountId
            ? [override.accountId]
            : []
    );
    const candidate = await prisma.masterCandidate.findFirst({
        where: {
            hardGatePassed: true,
            status: 'ELIGIBLE',
            totalScore: { gte: config.publication.minimumScore },
            personId: { notIn: excludedPersonIds },
            accountId: { notIn: excludedAccountIds },
            snapshot: {
                playedAt: {
                    gte: new Date(
                        now.getTime() - config.source.lookbackDays * 86_400_000
                    ),
                },
                sourceGame: { availability: 'AVAILABLE' },
            },
        },
        orderBy: [
            { totalScore: 'desc' },
            { snapshot: { playedAt: 'desc' } },
            { candidateKey: 'asc' },
        ],
    });
    if (!candidate) return null;
    return prisma.$transaction(
        (tx) =>
            publishMasterCandidate(tx, {
                candidateId: candidate.id,
                slotKey: WEEKLY_MASTER_SLOT_KEY,
                now,
            }),
        { timeout: 30_000 }
    );
}

export type LandingMasterPuzzleDto =
    | {
          state: 'unavailable';
          slot: { key: string; version: number };
      }
    | {
          state: 'ready' | 'fallback';
          slot: { key: string; version: number };
          publication: {
              id: string;
              slug: string;
              headline: string;
              teaser: string;
              attributionLabel: string;
              health: 'FRESH' | 'STALE' | 'SOURCE_MISSING' | 'BLOCKED';
              publishedAt: string;
              sourceUrl: string | null;
              prompt: TrainingPromptDto;
              context: {
                  sourceUrl: string | null;
                  playedAt: string;
                  players: {
                      white: { name: string; rating: number | null };
                      black: { name: string; rating: number | null };
                  };
              };
          };
      };

export async function getPublicMasterSlot(
    key = WEEKLY_MASTER_SLOT_KEY,
    now = new Date()
): Promise<LandingMasterPuzzleDto> {
    const slot = await prisma.masterSlot.findUnique({
        where: { key },
        include: {
            currentPublication: true,
            fallbackPublication: true,
            overrides: {
                where: {
                    revokedAt: null,
                    startsAt: { lte: now },
                    expiresAt: { gt: now },
                    kind: { in: ['PIN_PUBLICATION', 'FORCE_FALLBACK'] },
                },
                include: { targetPublication: true },
                orderBy: [{ createdAt: 'desc' }],
            },
        },
    });
    if (!slot) {
        return { state: 'unavailable', slot: { key, version: 0 } };
    }
    const pin = slot.overrides.find(
        (override) => override.kind === 'PIN_PUBLICATION'
    );
    const forceFallback = slot.overrides.some(
        (override) => override.kind === 'FORCE_FALLBACK'
    );
    const preferred = pin?.targetPublication ??
        (forceFallback ? slot.fallbackPublication : slot.currentPublication);
    const preferredBlocked = preferred
        ? await publicationIsOverriddenWithdrawn(preferred.id, now)
        : true;
    const preferredUsable =
        preferred &&
        preferred.status === 'PUBLISHED' &&
        preferred.health !== 'BLOCKED' &&
        preferred.health !== 'SOURCE_MISSING' &&
        !preferredBlocked;
    const fallbackBlocked = slot.fallbackPublication
        ? await publicationIsOverriddenWithdrawn(
              slot.fallbackPublication.id,
              now
          )
        : true;
    const fallbackUsable =
        slot.fallbackPublication &&
        slot.fallbackPublication.status === 'PUBLISHED' &&
        slot.fallbackPublication.health !== 'BLOCKED' &&
        slot.fallbackPublication.health !== 'SOURCE_MISSING' &&
        !fallbackBlocked;
    const selected = preferredUsable
        ? preferred
        : fallbackUsable
          ? slot.fallbackPublication
          : null;
    const config = weeklyMasterConfig();
    const olderThanMaximum =
        selected != null &&
        now.getTime() - selected.publishedAt.getTime() >
            config.publication.maxStaleDays * 86_400_000;
    if (!selected || olderThanMaximum) {
        return {
            state: 'unavailable',
            slot: { key: slot.key, version: slot.version },
        };
    }
    const isFallback =
        forceFallback || !preferredUsable || selected.health !== 'FRESH';
    const review = selected.reviewPayload as {
        sourceUrl?: unknown;
        playedAt?: unknown;
        players?: {
            white?: { name?: unknown; rating?: unknown };
            black?: { name?: unknown; rating?: unknown };
        };
    };
    return {
        state: isFallback ? 'fallback' : 'ready',
        slot: { key: slot.key, version: slot.version },
        publication: {
            id: selected.id,
            slug: selected.slug,
            headline: selected.headline,
            teaser: selected.teaser,
            attributionLabel: selected.attributionLabel,
            health: selected.health,
            publishedAt: selected.publishedAt.toISOString(),
            sourceUrl:
                typeof review.sourceUrl === 'string' ? review.sourceUrl : null,
            prompt: selected.promptPayload as unknown as TrainingPromptDto,
            context: {
                sourceUrl:
                    typeof review.sourceUrl === 'string'
                        ? review.sourceUrl
                        : null,
                playedAt:
                    typeof review.playedAt === 'string'
                        ? review.playedAt
                        : selected.publishedAt.toISOString(),
                players: {
                    white: {
                        name:
                            typeof review.players?.white?.name === 'string'
                                ? review.players.white.name
                                : 'White',
                        rating:
                            typeof review.players?.white?.rating === 'number'
                                ? review.players.white.rating
                                : null,
                    },
                    black: {
                        name:
                            typeof review.players?.black?.name === 'string'
                                ? review.players.black.name
                                : 'Black',
                        rating:
                            typeof review.players?.black?.rating === 'number'
                                ? review.players.black.rating
                                : null,
                    },
                },
            },
        },
    };
}

async function publicationIsOverriddenWithdrawn(
    publicationId: string,
    now: Date
) {
    return (
        (await prisma.masterAdminOverride.count({
            where: {
                kind: 'WITHDRAW_PUBLICATION',
                publicationId,
                revokedAt: null,
                startsAt: { lte: now },
                expiresAt: { gt: now },
            },
        })) > 0
    );
}

async function currentPublicationIsThisWeek(
    publicationId: string,
    now: Date
) {
    const publication = await prisma.masterPublication.findUnique({
        where: { id: publicationId },
        select: { status: true, health: true, publishedAt: true },
    });
    if (
        !publication ||
        publication.status !== 'PUBLISHED' ||
        publication.health === 'BLOCKED'
    ) {
        return false;
    }
    const start = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
    );
    const day = start.getUTCDay() || 7;
    start.setUTCDate(start.getUTCDate() - day + 1);
    return publication.publishedAt >= start;
}

export async function markStaleMasterPublications(now = new Date()) {
    const config = weeklyMasterConfig();
    const staleBefore = new Date(
        now.getTime() - config.publication.freshForDays * 86_400_000
    );
    return prisma.masterPublication.updateMany({
        where: {
            status: 'PUBLISHED',
            health: 'FRESH',
            publishedAt: { lt: staleBefore },
        },
        data: {
            health: 'STALE',
            staleSince: now,
            healthReason: 'Publication exceeded the configured freshness window',
            lastCheckedAt: now,
        },
    });
}

export async function revalidateSelectedMasterSources(now = new Date()) {
    const slots = await prisma.masterSlot.findMany({
        where: {
            OR: [
                { currentPublicationId: { not: null } },
                { fallbackPublicationId: { not: null } },
            ],
        },
        select: {
            currentPublication: {
                include: {
                    candidate: {
                        include: { snapshot: { include: { sourceGame: true } } },
                    },
                },
            },
            fallbackPublication: {
                include: {
                    candidate: {
                        include: { snapshot: { include: { sourceGame: true } } },
                    },
                },
            },
        },
    });
    const publications = new Map<
        string,
        NonNullable<(typeof slots)[number]['currentPublication']>
    >();
    for (const slot of slots) {
        if (slot.currentPublication) {
            publications.set(slot.currentPublication.id, slot.currentPublication);
        }
        if (slot.fallbackPublication) {
            publications.set(slot.fallbackPublication.id, slot.fallbackPublication);
        }
    }

    let checked = 0;
    let missing = 0;
    let restored = 0;
    await Promise.all(
        [...publications.values()].map(async (publication) => {
            const sourceGame = publication.candidate.snapshot.sourceGame;
            const sourceUrl =
                publication.sourceUrl ?? publication.candidate.snapshot.sourceUrl;
            if (!sourceUrl || !isTrustedMasterSourceUrl(sourceUrl)) return;
            let response: Response;
            try {
                response = await fetch(sourceUrl, {
                    method: 'HEAD',
                    redirect: 'follow',
                    signal: AbortSignal.timeout(6_000),
                    headers: { 'user-agent': 'Backranq source health check' },
                });
            } catch {
                return;
            }
            checked += 1;
            if (response.status === 404 || response.status === 410) {
                const changed = await prisma.$transaction(async (tx) => {
                    await tx.masterSourceGame.update({
                        where: { id: sourceGame.id },
                        data: {
                            availability: 'MISSING',
                            missingSince: sourceGame.missingSince ?? now,
                            lastCheckedAt: now,
                            lastError: `Source returned HTTP ${response.status}`,
                        },
                    });
                    const updated = await tx.masterPublication.updateMany({
                        where: {
                            id: publication.id,
                            health: { not: 'SOURCE_MISSING' },
                        },
                        data: {
                            health: 'SOURCE_MISSING',
                            healthReason: `Source returned HTTP ${response.status}`,
                            lastCheckedAt: now,
                        },
                    });
                    if (updated.count > 0) {
                        await tx.masterSlot.updateMany({
                            where: {
                                OR: [
                                    { currentPublicationId: publication.id },
                                    { fallbackPublicationId: publication.id },
                                ],
                            },
                            data: { version: { increment: 1 }, resolvedAt: now },
                        });
                    }
                    return updated.count;
                });
                missing += changed;
                return;
            }
            if (!response.ok) return;
            const config = weeklyMasterConfig();
            const nextHealth =
                now.getTime() - publication.publishedAt.getTime() >
                config.publication.freshForDays * 86_400_000
                    ? 'STALE'
                    : 'FRESH';
            const changed = await prisma.$transaction(async (tx) => {
                await tx.masterSourceGame.update({
                    where: { id: sourceGame.id },
                    data: {
                        availability: 'AVAILABLE',
                        missingSince: null,
                        lastCheckedAt: now,
                        lastError: null,
                    },
                });
                const updated = await tx.masterPublication.updateMany({
                    where: { id: publication.id, health: 'SOURCE_MISSING' },
                    data: {
                        health: nextHealth,
                        healthReason: null,
                        lastCheckedAt: now,
                        staleSince: nextHealth === 'STALE' ? now : null,
                    },
                });
                if (updated.count > 0) {
                    await tx.masterSlot.updateMany({
                        where: {
                            OR: [
                                { currentPublicationId: publication.id },
                                { fallbackPublicationId: publication.id },
                            ],
                        },
                        data: { version: { increment: 1 }, resolvedAt: now },
                    });
                }
                return updated.count;
            });
            restored += changed;
        })
    );
    return { checked, missing, restored };
}

function isTrustedMasterSourceUrl(value: string) {
    try {
        const url = new URL(value);
        return (
            url.protocol === 'https:' &&
            (url.hostname === 'lichess.org' ||
                url.hostname === 'www.chess.com' ||
                url.hostname === 'chess.com')
        );
    } catch {
        return false;
    }
}
