import { Prisma, type PrismaClient } from '@prisma/client';
import { PROGRESS_RECOMMENDATION_KEYS } from '@/lib/progress/analytics';

const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FOCUSES = ['ALL', 'MEANINGFUL', 'MAJOR'] as const;
const TERMINAL_REASONS = [
    'MOVE_SUBMITTED',
    'REVEALED',
    'ABANDONED',
    'REPLACED',
    'NAVIGATED_AWAY',
] as const;
const MAX_FUTURE_SKEW_MS = 5 * 60_000;
const MAX_EXPOSURE_AGE_MS = 30 * 24 * 60 * 60_000;

type PracticeFocus = (typeof FOCUSES)[number];
type TerminalReason = (typeof TERMINAL_REASONS)[number];
type RecommendationKey =
    (typeof PROGRESS_RECOMMENDATION_KEYS)[number];

type CommonExposure = {
    clientExposureId: string;
    clientEventId: string;
    momentId: string;
    solutionRevisionId: string;
    shownAt: string;
    occurredAt: string;
    /** Only this explicit external entry is accepted; omission means Practice. */
    entry?: 'progress';
    recommendationKey?: RecommendationKey;
    focus?: PracticeFocus;
};

export type PracticeExposureWrite =
    | (CommonExposure & { kind: 'SHOWN' })
    | (CommonExposure & {
          kind: 'TERMINAL';
          terminalReason: TerminalReason;
          attemptId?: string;
      });

type ExposureDb = Pick<
    PrismaClient,
    'trainingMoment' | 'trainingAttempt' | 'practiceExposure'
>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return (
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value)
    );
}

function oneOf<T extends readonly unknown[]>(
    values: T,
    value: unknown
): value is T[number] {
    return values.includes(value);
}

export function parsePracticeExposureWrite(
    value: unknown,
    now = new Date()
): PracticeExposureWrite | null {
    if (!isRecord(value)) return null;
    const commonKeys = [
        'kind',
        'clientExposureId',
        'clientEventId',
        'momentId',
        'solutionRevisionId',
        'shownAt',
        'occurredAt',
        'entry',
        'recommendationKey',
        'focus',
    ];
    const allowed =
        value.kind === 'SHOWN'
            ? commonKeys
            : value.kind === 'TERMINAL'
              ? [...commonKeys, 'terminalReason', 'attemptId']
              : null;
    if (
        !allowed ||
        !Object.keys(value).every((key) => allowed.includes(key)) ||
        typeof value.clientExposureId !== 'string' ||
        !UUID_RE.test(value.clientExposureId) ||
        typeof value.clientEventId !== 'string' ||
        !UUID_RE.test(value.clientEventId) ||
        typeof value.momentId !== 'string' ||
        !UUID_RE.test(value.momentId) ||
        typeof value.solutionRevisionId !== 'string' ||
        !UUID_RE.test(value.solutionRevisionId) ||
        (value.entry !== undefined && value.entry !== 'progress') ||
        (value.focus !== undefined &&
            !oneOf(FOCUSES, value.focus)) ||
        (value.recommendationKey !== undefined &&
            !oneOf(
                PROGRESS_RECOMMENDATION_KEYS,
                value.recommendationKey
            )) ||
        typeof value.shownAt !== 'string' ||
        typeof value.occurredAt !== 'string'
    ) {
        return null;
    }
    const shownAt = new Date(value.shownAt);
    const occurredAt = new Date(value.occurredAt);
    if (
        Number.isNaN(shownAt.getTime()) ||
        Number.isNaN(occurredAt.getTime()) ||
        shownAt.toISOString() !== value.shownAt ||
        occurredAt.toISOString() !== value.occurredAt ||
        occurredAt.getTime() < shownAt.getTime() ||
        occurredAt.getTime() > now.getTime() + MAX_FUTURE_SKEW_MS ||
        shownAt.getTime() < now.getTime() - MAX_EXPOSURE_AGE_MS
    ) {
        return null;
    }
    if (value.kind === 'SHOWN') {
        return value as PracticeExposureWrite;
    }
    if (
        !oneOf(TERMINAL_REASONS, value.terminalReason) ||
        (value.attemptId !== undefined &&
            (typeof value.attemptId !== 'string' ||
                !UUID_RE.test(value.attemptId)))
    ) {
        return null;
    }
    const requiresAttempt =
        value.terminalReason === 'MOVE_SUBMITTED' ||
        value.terminalReason === 'REVEALED';
    if (requiresAttempt !== (value.attemptId !== undefined)) {
        return null;
    }
    return value as PracticeExposureWrite;
}

export async function recordPracticeExposure(args: {
    db: ExposureDb;
    userId: string;
    event: PracticeExposureWrite;
}) {
    const moment = await args.db.trainingMoment.findFirst({
        where: {
            id: args.event.momentId,
            userId: args.userId,
            ...(args.event.kind === 'SHOWN'
                ? {
                      status: 'ACTIVE',
                      archivedAt: null,
                      currentSolutionRevisionId:
                          args.event.solutionRevisionId,
                  }
                : {
                      solutionRevisions: {
                          some: {
                              id: args.event.solutionRevisionId,
                          },
                      },
                  }),
        },
        select: { id: true },
    });
    if (!moment) {
        return { ok: false, reason: 'NOT_FOUND' } as const;
    }

    let attemptId: string | null = null;
    if (
        args.event.kind === 'TERMINAL' &&
        args.event.attemptId
    ) {
        const attempt = await args.db.trainingAttempt.findFirst({
            where: {
                id: args.event.attemptId,
                userId: args.userId,
                trainingMomentId: args.event.momentId,
                solutionRevisionId:
                    args.event.solutionRevisionId,
                ...(args.event.terminalReason === 'REVEALED'
                    ? { status: 'REVEALED' }
                    : { status: { not: 'REVEALED' } }),
            },
            select: { id: true },
        });
        if (!attempt) {
            return { ok: false, reason: 'NOT_FOUND' } as const;
        }
        attemptId = attempt.id;
    }

    try {
        await args.db.practiceExposure.create({
            data: {
                userId: args.userId,
                trainingMomentId: args.event.momentId,
                solutionRevisionId:
                    args.event.solutionRevisionId,
                attemptId,
                clientExposureId:
                    args.event.clientExposureId,
                clientEventId: args.event.clientEventId,
                kind: args.event.kind,
                shownAt: new Date(args.event.shownAt),
                clientOccurredAt: new Date(
                    args.event.occurredAt
                ),
                entrySurface:
                    args.event.entry === 'progress'
                        ? 'PROGRESS'
                        : 'PRACTICE',
                recommendationKey:
                    args.event.recommendationKey ?? null,
                focus: args.event.focus ?? null,
                terminalReason:
                    args.event.kind === 'TERMINAL'
                        ? args.event.terminalReason
                        : null,
            },
        });
        return {
            ok: true,
            duplicate: false,
        } as const;
    } catch (error) {
        if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === 'P2002'
        ) {
            return { ok: true, duplicate: true } as const;
        }
        throw error;
    }
}
