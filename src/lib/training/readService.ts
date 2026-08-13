import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type {
    PracticeFeedRequest,
    PracticeFeedResponse,
    PracticeFilters,
    TrainingMomentResponse,
} from '@/lib/training/api';
import { toTrainingPromptDto } from '@/lib/training/apiMappers';
import {
    queryDuePracticeStream,
    queryNewPracticeStream,
} from '@/lib/training/practiceFeedQueries';
import {
    interleavePracticeStreams,
    initialPracticeScheduleCursor,
    type DueScheduleCursor,
    type DueScheduleKey,
    type NewScheduleCursor,
    type NewScheduleKey,
    type PracticeScheduleCursor,
} from '@/lib/training/practiceScheduler';

type TrainingReadClient = Pick<
    Prisma.TransactionClient,
    'trainingMoment' | '$queryRaw'
>;

type PracticeFeedCursor = {
    version: 2;
    purpose: 'practice-feed';
    userId: string;
    feedStartedAt: string;
    filterHash: string;
    schedule: PracticeScheduleCursor;
    issuedAt: number;
    expiresAt: number;
};

export const PRACTICE_FEED_CURSOR_TTL_MS = 6 * 60 * 60_000;
const PRACTICE_FEED_CURSOR_MAX_LENGTH = 1_024;
const MIN_SAFE_PRACTICE_INSTANT_MS = Date.parse('2000-01-01T00:00:00.000Z');
const MAX_SAFE_PRACTICE_INSTANT_MS = Date.parse('2100-01-01T00:00:00.000Z');

const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function cursorSecret() {
    const secret =
        process.env.PRACTICE_FEED_CURSOR_SECRET?.trim() ||
        process.env.AUTH_SECRET?.trim() ||
        process.env.NEXTAUTH_SECRET?.trim();
    if (!secret) throw new Error('Practice feed cursor signing is not configured');
    return secret;
}

function encodeCursor(cursor: PracticeFeedCursor): string {
    const encoded = Buffer.from(JSON.stringify(cursor), 'utf8').toString(
        'base64url'
    );
    const signature = createHmac('sha256', cursorSecret())
        .update(`practice-feed:${encoded}`)
        .digest('base64url');
    const value = `${encoded}.${signature}`;
    if (value.length > PRACTICE_FEED_CURSOR_MAX_LENGTH) {
        throw new Error('Practice feed cursor exceeded its safe size');
    }
    return value;
}

function decodeCanonicalBase64Url(value: string): Buffer | null {
    if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
    const decoded = Buffer.from(value, 'base64url');
    return decoded.toString('base64url') === value ? decoded : null;
}

function decodeCursor(value: string, args: {
    userId: string;
    filterHash: string;
    requestTime: Date;
}): {
    feedStartedAt: Date;
    filterHash: string;
    schedule: PracticeScheduleCursor;
    issuedAt: number;
    expiresAt: number;
} | null {
    try {
        if (!value || value.length > PRACTICE_FEED_CURSOR_MAX_LENGTH) {
            return null;
        }
        const [encoded, signature, extra] = value.split('.');
        if (!encoded || !signature || extra) return null;
        const payload = decodeCanonicalBase64Url(encoded);
        const receivedSignature = decodeCanonicalBase64Url(signature);
        if (!payload || !receivedSignature) return null;
        const expectedSignature = createHmac('sha256', cursorSecret())
            .update(`practice-feed:${encoded}`)
            .digest();
        if (
            receivedSignature.length !== expectedSignature.length ||
            !timingSafeEqual(receivedSignature, expectedSignature)
        ) {
            return null;
        }
        const decoded = JSON.parse(
            payload.toString('utf8')
        ) as Partial<PracticeFeedCursor>;
        if (
            decoded.version !== 2 ||
            decoded.purpose !== 'practice-feed' ||
            decoded.userId !== args.userId ||
            typeof decoded.feedStartedAt !== 'string' ||
            typeof decoded.filterHash !== 'string' ||
            decoded.filterHash !== args.filterHash ||
            !/^[a-f0-9]{64}$/.test(decoded.filterHash) ||
            !isPracticeScheduleCursor(decoded.schedule) ||
            !Number.isSafeInteger(decoded.issuedAt) ||
            !Number.isSafeInteger(decoded.expiresAt) ||
            (decoded.issuedAt ?? Infinity) > args.requestTime.getTime() ||
            (decoded.expiresAt ?? -Infinity) <= args.requestTime.getTime() ||
            (decoded.expiresAt ?? 0) - (decoded.issuedAt ?? 0) !==
                PRACTICE_FEED_CURSOR_TTL_MS
        ) {
            return null;
        }
        const feedStartedAt = new Date(decoded.feedStartedAt);
        if (
            !isSafePracticeInstant(decoded.feedStartedAt) ||
            feedStartedAt.getTime() > args.requestTime.getTime() ||
            feedStartedAt.getTime() <
                args.requestTime.getTime() - PRACTICE_FEED_CURSOR_TTL_MS
        ) {
            return null;
        }
        return {
            feedStartedAt,
            filterHash: decoded.filterHash,
            schedule: decoded.schedule,
            issuedAt: decoded.issuedAt!,
            expiresAt: decoded.expiresAt!,
        };
    } catch {
        return null;
    }
}

function isSafePracticeInstant(value: unknown): value is string {
    if (typeof value !== 'string') return false;
    const parsed = new Date(value);
    return (
        Number.isFinite(parsed.getTime()) &&
        parsed.toISOString() === value &&
        parsed.getTime() >= MIN_SAFE_PRACTICE_INSTANT_MS &&
        parsed.getTime() < MAX_SAFE_PRACTICE_INSTANT_MS
    );
}

function isNewScheduleKey(value: unknown): value is NewScheduleKey {
    if (!value || typeof value !== 'object') return false;
    const key = value as Partial<NewScheduleKey>;
    return (
        isSafePracticeInstant(key.createdAt) &&
        typeof key.id === 'string' &&
        UUID_RE.test(key.id)
    );
}

function isDueScheduleKey(value: unknown): value is DueScheduleKey {
    if (!value || typeof value !== 'object') return false;
    const key = value as Partial<DueScheduleKey>;
    return (
        (key.bucket === 'LAPSED' || key.bucket === 'CLEAN') &&
        isSafePracticeInstant(key.nextDueAt) &&
        typeof key.id === 'string' &&
        UUID_RE.test(key.id)
    );
}

function isDueScheduleCursor(value: unknown): value is DueScheduleCursor {
    if (!value || typeof value !== 'object') return false;
    const cursor = value as Partial<DueScheduleCursor>;
    if (cursor.bucket === 'DONE') return cursor.after === null;
    return (
        (cursor.bucket === 'LAPSED' || cursor.bucket === 'CLEAN') &&
        (cursor.after === null ||
            (isDueScheduleKey(cursor.after) &&
                cursor.after.bucket === cursor.bucket))
    );
}

function isNewScheduleCursor(value: unknown): value is NewScheduleCursor {
    if (!value || typeof value !== 'object') return false;
    const cursor = value as Partial<NewScheduleCursor>;
    return (
        typeof cursor.exhausted === 'boolean' &&
        (cursor.after === null || isNewScheduleKey(cursor.after))
    );
}

function isPracticeScheduleCursor(
    value: unknown
): value is PracticeScheduleCursor {
    if (!value || typeof value !== 'object') return false;
    const cursor = value as Partial<PracticeScheduleCursor>;
    return (
        Number.isSafeInteger(cursor.patternIndex) &&
        (cursor.patternIndex ?? -1) >= 0 &&
        (cursor.patternIndex ?? 3) < 3 &&
        isDueScheduleCursor(cursor.due) &&
        isNewScheduleCursor(cursor.fresh)
    );
}

function sorted(values: readonly string[] | undefined): string[] {
    return Array.from(new Set(values ?? [])).sort();
}

function practiceFilterHash(filters: PracticeFilters): string {
    return createHash('sha256')
        .update(
            JSON.stringify({
                focus: filters.focus ?? 'ALL',
                phases: sorted(filters.phases),
                sourceKinds: sorted(filters.sourceKinds),
                lessonKinds: sorted(filters.lessonKinds),
                themes: sorted(filters.themes),
                minConfidence:
                    filters.minConfidence ?? null,
                mode: filters.mode ?? 'RECOMMENDED',
                gameId: filters.gameId ?? null,
            })
        )
        .digest('hex');
}

const promptSelect = {
    id: true,
    currentSolutionRevisionId: true,
    fen: true,
    sideToMove: true,
    positionHistory: true,
    gameId: true,
    decisionPly: true,
    originalMoveUci: true,
    scoreBefore: true,
    scoreAfter: true,
    cpLoss: true,
    winChanceLoss: true,
    sourceKinds: true,
    lessonKinds: true,
    themes: true,
    game: {
        select: {
            provider: true,
            playedAt: true,
        },
    },
    currentSolutionRevision: {
        select: {
            bestMoveUci: true,
            acceptedMovesUci: true,
            acceptanceFrontier: true,
            solutionShape: true,
            bestLine: true,
            scoreAtStart: true,
            gradingPolicy: true,
            solutionTree: true,
            moveAssessments: {
                where: { status: 'VERIFIED' },
                orderBy: [
                    { decisionIndex: 'asc' as const },
                    { moveUci: 'asc' as const },
                ],
                select: {
                    decisionIndex: true,
                    fen: true,
                    moveUci: true,
                    source: true,
                    status: true,
                    grade: true,
                    scoreAfter: true,
                    evidence: true,
                },
            },
        },
    },
    createdAt: true,
    lastTrainedAt: true,
} satisfies Prisma.TrainingMomentSelect;

export class InvalidPracticeFeedCursorError extends Error {
    constructor() {
        super('Invalid practice feed cursor');
        this.name = 'InvalidPracticeFeedCursorError';
    }
}

export async function listPracticeFeed(args: {
    db: TrainingReadClient;
    userId: string;
    request: PracticeFeedRequest;
    now?: () => Date;
}): Promise<Omit<PracticeFeedResponse, 'ownerId'>> {
    const limit = args.request.limit ?? 10;
    const filters = args.request.filters ?? {};
    const mode = filters.mode ?? 'RECOMMENDED';
    const filterHash = practiceFilterHash(filters);
    const requestTime = (args.now ?? (() => new Date()))();
    if (!Number.isFinite(requestTime.getTime())) {
        throw new InvalidPracticeFeedCursorError();
    }
    const cursor = args.request.cursor
        ? decodeCursor(args.request.cursor, {
              userId: args.userId,
              filterHash,
              requestTime,
          })
        : null;
    if (args.request.cursor && !cursor) {
        throw new InvalidPracticeFeedCursorError();
    }
    const feedStartedAt = cursor?.feedStartedAt ?? requestTime;
    const schedule = cursor?.schedule ?? initialPracticeScheduleCursor();

    const streamTake = limit + 1;
    const [due, fresh] = await Promise.all([
        mode === 'NEW'
            ? Promise.resolve({
                  candidates: [],
                  startedAt: schedule.due,
                  scannedThrough: {
                      bucket: 'DONE' as const,
                      after: null,
                  },
              })
            : queryDuePracticeStream({
                  db: args.db,
                  userId: args.userId,
                  feedStartedAt,
                  filters,
                  cursor: schedule.due,
                  take: streamTake,
              }),
        mode === 'REVIEW'
            ? Promise.resolve({
                  candidates: [],
                  startedAt: schedule.fresh,
                  scannedThrough: {
                      after: schedule.fresh.after,
                      exhausted: true,
                  },
              })
            : queryNewPracticeStream({
                  db: args.db,
                  userId: args.userId,
                  feedStartedAt,
                  filters,
                  cursor: schedule.fresh,
                  take: streamTake,
              }),
    ]);
    const scheduled = interleavePracticeStreams({
        due,
        fresh,
        mode,
        limit,
        patternIndex: schedule.patternIndex,
    });
    if (scheduled.selected.length === 0) {
        return {
            items: [],
            appliedFilters: filters,
            nextCursor: scheduled.hasMore
                ? encodeCursor({
                      version: 2,
                      purpose: 'practice-feed',
                      userId: args.userId,
                      feedStartedAt: feedStartedAt.toISOString(),
                      filterHash,
                      schedule: scheduled.cursor,
                      issuedAt: cursor?.issuedAt ?? requestTime.getTime(),
                      expiresAt:
                          cursor?.expiresAt ??
                          requestTime.getTime() +
                              PRACTICE_FEED_CURSOR_TTL_MS,
                  })
                : null,
        };
    }

    const rows = await args.db.trainingMoment.findMany({
        where: {
            userId: args.userId,
            status: 'ACTIVE',
            archivedAt: null,
            OR: scheduled.selected.map((candidate) => ({
                id: candidate.id,
                currentSolutionRevisionId:
                    candidate.currentSolutionRevisionId,
            })),
            currentSolutionRevision: {
                is: {
                    trainable: true,
                    verificationStatus: 'VERIFIED',
                    acceptanceFrontier: {
                        path: ['status'],
                        equals: 'STABLE',
                    },
                },
            },
        },
        select: promptSelect,
    });
    const byCandidate = new Map(
        rows.map((row) => [
            `${row.id}:${row.currentSolutionRevisionId ?? ''}`,
            row,
        ])
    );
    const visible = scheduled.selected.flatMap((candidate) => {
        const row = byCandidate.get(
            `${candidate.id}:${candidate.currentSolutionRevisionId}`
        );
        return row ? [row] : [];
    });
    return {
        items: visible.map(toTrainingPromptDto),
        appliedFilters: filters,
        nextCursor:
            scheduled.hasMore
                ? encodeCursor({
                      version: 2,
                      purpose: 'practice-feed',
                      userId: args.userId,
                      feedStartedAt: feedStartedAt.toISOString(),
                      filterHash,
                      schedule: scheduled.cursor,
                      issuedAt: cursor?.issuedAt ?? requestTime.getTime(),
                      expiresAt:
                          cursor?.expiresAt ??
                          requestTime.getTime() +
                              PRACTICE_FEED_CURSOR_TTL_MS,
                  })
                : null,
    };
}

export async function getTrainingMomentPrompt(args: {
    db: TrainingReadClient;
    userId: string;
    momentId: string;
}): Promise<Omit<TrainingMomentResponse, 'ownerId'> | null> {
    const row = await args.db.trainingMoment.findFirst({
        where: {
            id: args.momentId,
            userId: args.userId,
            status: 'ACTIVE',
            archivedAt: null,
            currentSolutionRevisionId: { not: null },
            currentSolutionRevision: {
                is: {
                    trainable: true,
                    verificationStatus: 'VERIFIED',
                    acceptanceFrontier: {
                        path: ['status'],
                        equals: 'STABLE',
                    },
                },
            },
        },
        select: promptSelect,
    });
    return row ? { moment: toTrainingPromptDto(row) } : null;
}
