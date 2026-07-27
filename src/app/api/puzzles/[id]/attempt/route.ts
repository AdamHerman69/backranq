import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { aggregatePuzzleStats } from '@/lib/api/puzzles';
import {
    isValidUciMove,
    puzzleOutcomeFromMove,
    puzzleOutcomeToSentinel,
    PUZZLE_ATTEMPT_REVEALED_SENTINEL,
    PUZZLE_ATTEMPT_SKIPPED_SENTINEL,
    MAX_PUZZLE_ATTEMPT_TIME_MS,
    type PuzzleNonMoveOutcome,
} from '@/lib/puzzles/attemptOutcomes';

export const runtime = 'nodejs';

function normalizeUci(s: string): string {
    return (s ?? '').trim().toLowerCase();
}

function isUuid(value: string) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        value
    );
}

function matchesImmutableAttemptPayload(
    attempt: {
        puzzleId: string;
        userId: string;
        userMoveUci: string;
        wasCorrect: boolean;
        timeSpentMs: number | null;
    },
    expected: {
        puzzleId: string;
        userId: string;
        userMoveUci: string;
        wasCorrect: boolean;
        timeSpentMs: number | null;
    }
) {
    return (
        attempt.puzzleId === expected.puzzleId &&
        attempt.userId === expected.userId &&
        normalizeUci(attempt.userMoveUci) ===
            normalizeUci(expected.userMoveUci) &&
        attempt.wasCorrect === expected.wasCorrect &&
        attempt.timeSpentMs === expected.timeSpentMs
    );
}

export async function POST(
    req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId)
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id } = await params;
    const body = (await req.json().catch(() => null)) as {
        clientAttemptId?: string;
        userMoveUci?: string;
        outcome?: PuzzleNonMoveOutcome;
        wasCorrect?: boolean;
        timeSpentMs?: number;
    } | null;

    const userMoveUci =
        typeof body?.userMoveUci === 'string' ? body.userMoveUci.trim() : '';
    const clientAttemptId =
        typeof body?.clientAttemptId === 'string'
            ? body.clientAttemptId.trim().toLowerCase()
            : null;
    const outcome =
        body?.outcome === 'revealed' || body?.outcome === 'skipped'
            ? body.outcome
            : null;
    if (body?.outcome !== undefined && outcome === null) {
        return NextResponse.json(
            { error: 'Invalid outcome' },
            { status: 400 }
        );
    }
    if (outcome && userMoveUci) {
        return NextResponse.json(
            { error: 'Provide outcome or userMoveUci, not both' },
            { status: 400 }
        );
    }
    if (!outcome && !userMoveUci) {
        return NextResponse.json(
            { error: 'Missing userMoveUci' },
            { status: 400 }
        );
    }
    if (outcome && !clientAttemptId) {
        return NextResponse.json(
            { error: 'clientAttemptId is required for outcomes' },
            { status: 400 }
        );
    }
    const hasTimeSpentMs = body?.timeSpentMs !== undefined;
    if (
        hasTimeSpentMs &&
        (typeof body?.timeSpentMs !== 'number' ||
            !Number.isFinite(body.timeSpentMs) ||
            body.timeSpentMs < 0 ||
            body.timeSpentMs > MAX_PUZZLE_ATTEMPT_TIME_MS)
    ) {
        return NextResponse.json(
            { error: 'Invalid timeSpentMs' },
            { status: 400 }
        );
    }
    const timeSpentMs = hasTimeSpentMs
        ? Math.trunc(body?.timeSpentMs as number)
        : null;
    if (clientAttemptId && !isUuid(clientAttemptId)) {
        return NextResponse.json(
            { error: 'Invalid clientAttemptId' },
            { status: 400 }
        );
    }
    const move = outcome
        ? puzzleOutcomeToSentinel(outcome)
        : normalizeUci(userMoveUci);
    if (!outcome && !isValidUciMove(move)) {
        return NextResponse.json(
            { error: 'Invalid userMoveUci' },
            { status: 400 }
        );
    }

    const puzzle = await prisma.puzzle.findFirst({
        where: { id, userId, archivedAt: null },
        select: { id: true, bestMoveUci: true, acceptedMovesUci: true },
    });
    if (!puzzle)
        return NextResponse.json({ error: 'Not found' }, { status: 404 });

    // Compute correctness server-side (do not trust client).
    const best = normalizeUci(puzzle.bestMoveUci);
    const accepted = new Set(
        [best, ...(puzzle.acceptedMovesUci ?? [])]
            .map((s) => normalizeUci(s))
            .filter(Boolean)
    );
    const priorOutcome = outcome
        ? null
        : await prisma.puzzleAttempt.findFirst({
              where: {
                  puzzleId: id,
                  userId,
                  userMoveUci: {
                      in: [
                          PUZZLE_ATTEMPT_REVEALED_SENTINEL,
                          PUZZLE_ATTEMPT_SKIPPED_SENTINEL,
                      ],
                  },
              },
              select: { id: true, userMoveUci: true },
          });
    const wasCorrect = outcome === null && !priorOutcome && accepted.has(move);

    let idempotent = false;
    if (clientAttemptId) {
        const existing = await prisma.puzzleAttempt.findUnique({
            where: { id: clientAttemptId },
            select: {
                puzzleId: true,
                userId: true,
                userMoveUci: true,
                wasCorrect: true,
                timeSpentMs: true,
            },
        });
        if (existing) {
            if (
                !matchesImmutableAttemptPayload(existing, {
                    puzzleId: id,
                    userId,
                    userMoveUci: move,
                    wasCorrect,
                    timeSpentMs,
                })
            ) {
                return NextResponse.json(
                    { error: 'clientAttemptId payload conflict' },
                    { status: 409 }
                );
            }
            idempotent = true;
        }
    }

    if (!idempotent) {
        try {
            await prisma.puzzleAttempt.create({
                data: {
                    ...(clientAttemptId ? { id: clientAttemptId } : {}),
                    puzzleId: id,
                    userId,
                    userMoveUci: move,
                    wasCorrect,
                    timeSpentMs,
                },
            });
        } catch (error) {
            const code =
                error && typeof error === 'object' && 'code' in error
                    ? error.code
                    : null;
            if (code !== 'P2002' || !clientAttemptId) throw error;
            const racedAttempt = await prisma.puzzleAttempt.findUnique({
                where: { id: clientAttemptId },
                select: {
                    puzzleId: true,
                    userId: true,
                    userMoveUci: true,
                    wasCorrect: true,
                    timeSpentMs: true,
                },
            });
            if (
                !racedAttempt ||
                !matchesImmutableAttemptPayload(racedAttempt, {
                    puzzleId: id,
                    userId,
                    userMoveUci: move,
                    wasCorrect,
                    timeSpentMs,
                })
            ) {
                return NextResponse.json(
                    { error: 'clientAttemptId payload conflict' },
                    { status: 409 }
                );
            }
            idempotent = true;
        }
    }

    const attempts = await prisma.puzzleAttempt.findMany({
        where: { puzzleId: id, userId },
        select: {
            wasCorrect: true,
            attemptedAt: true,
            timeSpentMs: true,
            userMoveUci: true,
        },
        orderBy: { attemptedAt: 'desc' },
    });

    const stats = aggregatePuzzleStats(attempts);
    return NextResponse.json({
        ok: true,
        idempotent,
        outcome: puzzleOutcomeFromMove(move),
        attemptStats: stats,
    });
}
