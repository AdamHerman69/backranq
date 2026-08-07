import { Prisma } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import {
    sendSmtp2GoEmail,
    Smtp2GoAmbiguousSendError,
    type Smtp2GoEmail,
} from '@/lib/notifications/smtp2go';

const DEFAULT_SMTP2GO_DAILY_SEND_LIMIT = 30;
const DEFAULT_SMTP2GO_TRANSACTIONAL_RESERVE = 5;
const EMAIL_RESERVATION_LEASE_MS = 15 * 60_000;
const MAX_RESERVATION_CLAIM_ATTEMPTS = 3;
const EXPIRED_RESERVATION_RECOVERY_LIMIT = 25;

type EmailSendOwnerType =
    | 'NOTIFICATION_DELIVERY'
    | 'PREMIUM_INVITATION';

type ReservationHandle = {
    id: string;
    ownerToken: string;
};

type ReservationClaim =
    | { kind: 'CLAIMED'; reservation: ReservationHandle }
    | { kind: 'REPLAYED'; providerMessageId: string };

export class EmailBudgetUnavailableError extends Error {
    readonly retryAt: Date;

    constructor(retryAt: Date) {
        super('SMTP2GO daily safety budget is exhausted');
        this.name = 'EmailBudgetUnavailableError';
        this.retryAt = retryAt;
    }
}

export class PracticeEmailWindowClaimedError extends Error {
    constructor() {
        super('A practice email already owns this local calendar-day window');
        this.name = 'PracticeEmailWindowClaimedError';
    }
}

export class EmailAttemptInProgressError extends Error {
    readonly retryAt: Date;

    constructor(retryAt: Date) {
        super('This logical email attempt is already in progress');
        this.name = 'EmailAttemptInProgressError';
        this.retryAt = retryAt;
    }
}

/**
 * Reserves the shared SMTP budget and (for Practice) the user's local-day send
 * window in one transaction, fences the irreversible provider handoff with the
 * caller's delivery token, and records whether the provider result was final or
 * ambiguous. Safe provider rejections release both reservations for retry.
 */
export async function sendReservedSmtp2GoEmail(args: {
    ownerType: EmailSendOwnerType;
    ownerId: string;
    ownerToken: string;
    logicalAttemptKey: string;
    priority: boolean;
    practiceWindowKey?: string;
    email: Smtp2GoEmail;
    clock?: () => Date;
}) {
    const now = args.clock?.() ?? new Date();
    const claim = await claimEmailReservation({
        ownerType: args.ownerType,
        ownerId: args.ownerId,
        ownerToken: args.ownerToken,
        logicalAttemptKey: args.logicalAttemptKey,
        priority: args.priority,
        practiceWindowKey: args.practiceWindowKey,
        now,
    });
    if (claim.kind === 'REPLAYED') return claim.providerMessageId;
    const reservation = claim.reservation;
    await markProviderHandoff(reservation);

    let providerMessageId: string;
    try {
        providerMessageId = await sendSmtp2GoEmail(args.email);
    } catch (error) {
        if (error instanceof Smtp2GoAmbiguousSendError) {
            await persistHandoffOutcome({
                reservation,
                status: 'AMBIGUOUS',
                providerMessageId: null,
                message: safeErrorMessage(error),
            });
        } else {
            await releaseEmailReservation(
                reservation,
                safeErrorMessage(error)
            );
        }
        throw error;
    }
    // A provider success followed by a database error is not safe to release:
    // the HANDOFF row remains durable and prevents a Practice duplicate.
    await persistHandoffOutcome({
        reservation,
        status: 'SENT',
        providerMessageId,
        message: null,
    });
    return providerMessageId;
}

async function persistHandoffOutcome(args: {
    reservation: ReservationHandle;
    status: 'SENT' | 'AMBIGUOUS';
    providerMessageId: string | null;
    message: string | null;
}) {
    try {
        await completeEmailReservation({
            ...args.reservation,
            status: args.status,
            providerMessageId: args.providerMessageId,
            message: args.message,
        });
    } catch (error) {
        throw new Smtp2GoAmbiguousSendError(
            'Email provider handoff could not be persisted safely; delivery must not be retried automatically',
            { cause: error }
        );
    }
}

async function claimEmailReservation(args: {
    ownerType: EmailSendOwnerType;
    ownerId: string;
    ownerToken: string;
    logicalAttemptKey: string;
    priority: boolean;
    practiceWindowKey?: string;
    now: Date;
}): Promise<ReservationClaim> {
    await releaseExpiredEmailReservations(args.now);
    for (
        let attempt = 1;
        attempt <= MAX_RESERVATION_CLAIM_ATTEMPTS;
        attempt += 1
    ) {
        const existing = await resolveExistingLogicalAttempt(
            args.logicalAttemptKey,
            args.now
        );
        if (existing) return existing;
        if (args.practiceWindowKey) {
            await releaseExpiredPracticeWindowReservation(
                args.practiceWindowKey,
                args.now
            );
        }
        try {
            const reservation = await prisma.$transaction(async (tx) => {
                const providerDay = utcDayStart(args.now);
                await tx.emailProviderDay.upsert({
                    where: { day: providerDay },
                    create: { day: providerDay },
                    update: {},
                });
                const totalLimit = smtp2GoDailySendLimit();
                const nonPriorityLimit = Math.max(
                    0,
                    totalLimit - smtp2GoTransactionalReserve()
                );
                const budget = await tx.emailProviderDay.updateMany({
                    where: {
                        day: providerDay,
                        reservedCount: { lt: totalLimit },
                        ...(!args.priority
                            ? {
                                  nonPriorityReservedCount: {
                                      lt: nonPriorityLimit,
                                  },
                              }
                            : {}),
                    },
                    data: {
                        reservedCount: { increment: 1 },
                        ...(!args.priority
                            ? { nonPriorityReservedCount: { increment: 1 } }
                            : {}),
                    },
                });
                if (budget.count !== 1) {
                    throw new EmailBudgetUnavailableError(
                        nextUtcQuotaWindow(args.now)
                    );
                }
                const reservation = await tx.emailSendReservation.create({
                    data: {
                        providerDay,
                        ownerType: args.ownerType,
                        ownerId: args.ownerId,
                        ownerToken: args.ownerToken,
                        logicalAttemptKey: args.logicalAttemptKey,
                        priority: args.priority,
                        practiceWindowKey: args.practiceWindowKey,
                        leaseUntil: new Date(
                            args.now.getTime() + EMAIL_RESERVATION_LEASE_MS
                        ),
                    },
                    select: { id: true, ownerToken: true },
                });
                return reservation;
            });
            return { kind: 'CLAIMED', reservation };
        } catch (error) {
            if (isLogicalAttemptUniqueConflict(error)) {
                const existing = await resolveExistingLogicalAttempt(
                    args.logicalAttemptKey,
                    args.now
                );
                if (existing) return existing;
                if (attempt < MAX_RESERVATION_CLAIM_ATTEMPTS) continue;
                throw new Error(
                    'Logical email attempt claim retry limit exceeded'
                );
            }
            if (
                !args.practiceWindowKey ||
                !isPracticeWindowUniqueConflict(error)
            ) {
                throw error;
            }
            const released =
                await releaseExpiredPracticeWindowReservation(
                    args.practiceWindowKey,
                    args.now
                );
            if (
                released &&
                attempt < MAX_RESERVATION_CLAIM_ATTEMPTS
            ) {
                continue;
            }
            throw new PracticeEmailWindowClaimedError();
        }
    }
    throw new Error('Email reservation claim retry limit exceeded');
}

async function resolveExistingLogicalAttempt(
    logicalAttemptKey: string,
    now: Date
): Promise<Extract<ReservationClaim, { kind: 'REPLAYED' }> | null> {
    const current = await prisma.emailSendReservation.findFirst({
        where: {
            logicalAttemptKey,
            status: { not: 'RELEASED' },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: {
            id: true,
            ownerToken: true,
            providerDay: true,
            priority: true,
            status: true,
            leaseUntil: true,
            providerMessageId: true,
        },
    });
    if (!current) return null;
    if (current.status === 'SENT') {
        if (!current.providerMessageId) {
            throw failClosedAttempt(
                'A sent logical email attempt is missing its provider ID'
            );
        }
        return {
            kind: 'REPLAYED',
            providerMessageId: current.providerMessageId,
        };
    }
    if (current.status === 'HANDOFF' || current.status === 'AMBIGUOUS') {
        throw failClosedAttempt(
            'This logical email attempt may already have reached the provider'
        );
    }
    if (current.status === 'RESERVED') {
        if (current.leaseUntil > now) {
            throw new EmailAttemptInProgressError(current.leaseUntil);
        }
        const released = await releaseExpiredReservation(
            {
                id: current.id,
                ownerToken: current.ownerToken,
                providerDay: current.providerDay,
                priority: current.priority,
            },
            now
        );
        if (!released) {
            throw new EmailAttemptInProgressError(
                new Date(now.getTime() + 1_000)
            );
        }
    }
    return null;
}

/**
 * Reclaims a fixed-size, index-ordered slice of claims whose owner crashed
 * before the irreversible provider handoff. HANDOFF and AMBIGUOUS rows are
 * deliberately never reclaimed because the provider may already have sent.
 */
export async function releaseExpiredEmailReservations(now = new Date()) {
    return prisma.$transaction(async (tx) => {
        const candidates = await tx.$queryRaw<
            Array<{
                id: string;
                ownerToken: string;
                providerDay: Date;
                priority: boolean;
            }>
        >(Prisma.sql`
            SELECT
                reservation."id",
                reservation."ownerToken",
                reservation."providerDay",
                reservation."priority"
            FROM "EmailSendReservation" reservation
            WHERE reservation."status" = 'RESERVED'::"EmailSendReservationStatus"
              AND reservation."leaseUntil" <= ${now}
            ORDER BY reservation."leaseUntil" ASC, reservation."id" ASC
            LIMIT ${EXPIRED_RESERVATION_RECOVERY_LIMIT}
            FOR UPDATE SKIP LOCKED
        `);
        let releasedCount = 0;
        for (const candidate of candidates) {
            if (await releaseExpiredReservation(candidate, now, tx)) {
                releasedCount += 1;
            }
        }
        return releasedCount;
    });
}

async function releaseExpiredReservation(
    candidate: {
        id: string;
        ownerToken: string;
        providerDay: Date;
        priority: boolean;
    },
    now: Date,
    existingTx?: Prisma.TransactionClient
) {
    const release = async (tx: Prisma.TransactionClient) => {
        const released = await tx.emailSendReservation.updateMany({
            where: {
                id: candidate.id,
                ownerToken: candidate.ownerToken,
                status: 'RESERVED',
                leaseUntil: { lte: now },
            },
            data: {
                status: 'RELEASED',
                practiceWindowKey: null,
                lastError: 'Reservation expired before provider handoff',
            },
        });
        if (released.count !== 1) return false;
        await decrementBudget(tx, candidate.providerDay, candidate.priority);
        return true;
    };
    return existingTx ? release(existingTx) : prisma.$transaction(release);
}

async function markProviderHandoff(reservation: ReservationHandle) {
    const transitioned = await prisma.emailSendReservation.updateMany({
        where: {
            id: reservation.id,
            ownerToken: reservation.ownerToken,
            status: 'RESERVED',
        },
        data: { status: 'HANDOFF' },
    });
    if (transitioned.count !== 1) {
        throw new Error('Email reservation no longer owns the provider handoff');
    }
}

async function completeEmailReservation(args: ReservationHandle & {
    status: 'SENT' | 'AMBIGUOUS';
    providerMessageId: string | null;
    message: string | null;
}) {
    const transitioned = await prisma.emailSendReservation.updateMany({
        where: {
            id: args.id,
            ownerToken: args.ownerToken,
            status: 'HANDOFF',
        },
        data: {
            status: args.status,
            providerMessageId: args.providerMessageId,
            lastError: args.message,
        },
    });
    if (transitioned.count !== 1) {
        throw new Error('Email provider result lost its reservation token');
    }
}

async function releaseEmailReservation(
    reservation: ReservationHandle,
    message: string
) {
    await prisma.$transaction(async (tx) => {
        const current = await tx.emailSendReservation.findUnique({
            where: { id: reservation.id },
            select: {
                ownerToken: true,
                providerDay: true,
                priority: true,
                status: true,
            },
        });
        if (
            !current ||
            current.ownerToken !== reservation.ownerToken ||
            !['RESERVED', 'HANDOFF'].includes(current.status)
        ) {
            return;
        }
        const released = await tx.emailSendReservation.updateMany({
            where: {
                id: reservation.id,
                ownerToken: reservation.ownerToken,
                status: { in: ['RESERVED', 'HANDOFF'] },
            },
            data: {
                status: 'RELEASED',
                practiceWindowKey: null,
                lastError: message,
            },
        });
        if (released.count !== 1) return;
        await decrementBudget(tx, current.providerDay, current.priority);
    });
}

async function releaseExpiredPracticeWindowReservation(
    practiceWindowKey: string,
    now: Date
) {
    return prisma.$transaction(async (tx) => {
        const current = await tx.emailSendReservation.findUnique({
            where: { practiceWindowKey },
            select: {
                id: true,
                ownerToken: true,
                providerDay: true,
                priority: true,
                status: true,
                leaseUntil: true,
            },
        });
        if (
            !current ||
            current.status !== 'RESERVED' ||
            current.leaseUntil > now
        ) {
            return false;
        }
        const released = await tx.emailSendReservation.updateMany({
            where: {
                id: current.id,
                ownerToken: current.ownerToken,
                status: 'RESERVED',
                leaseUntil: { lte: now },
            },
            data: {
                status: 'RELEASED',
                practiceWindowKey: null,
                lastError: 'Reservation expired before provider handoff',
            },
        });
        if (released.count !== 1) return false;
        await decrementBudget(tx, current.providerDay, current.priority);
        return true;
    });
}

async function decrementBudget(
    tx: Prisma.TransactionClient,
    providerDay: Date,
    priority: boolean
) {
    const decremented = await tx.emailProviderDay.updateMany({
        where: {
            day: providerDay,
            reservedCount: { gte: 1 },
            ...(!priority
                ? { nonPriorityReservedCount: { gte: 1 } }
                : {}),
        },
        data: {
            reservedCount: { decrement: 1 },
            ...(!priority
                ? { nonPriorityReservedCount: { decrement: 1 } }
                : {}),
        },
    });
    if (decremented.count !== 1) {
        throw new Error('Email provider budget invariant was violated');
    }
}

function smtp2GoDailySendLimit() {
    return positiveIntegerEnv(
        'SMTP2GO_DAILY_SEND_LIMIT',
        DEFAULT_SMTP2GO_DAILY_SEND_LIMIT
    );
}

function smtp2GoTransactionalReserve() {
    return Math.min(
        smtp2GoDailySendLimit(),
        positiveIntegerEnv(
            'SMTP2GO_TRANSACTIONAL_RESERVE',
            DEFAULT_SMTP2GO_TRANSACTIONAL_RESERVE
        )
    );
}

function positiveIntegerEnv(name: string, fallback: number) {
    const parsed = Number(process.env[name]);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function utcDayStart(now: Date) {
    return new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
    );
}

function nextUtcQuotaWindow(now: Date) {
    return new Date(utcDayStart(now).getTime() + 24 * 60 * 60_000 + 5 * 60_000);
}

function isPracticeWindowUniqueConflict(error: unknown) {
    return uniqueConflictTargets(error, 'practiceWindowKey');
}

function isLogicalAttemptUniqueConflict(error: unknown) {
    return uniqueConflictTargets(error, 'logicalAttemptKey');
}

function uniqueConflictTargets(error: unknown, field: string) {
    if (
        typeof error !== 'object' ||
        error === null ||
        !('code' in error) ||
        (error as { code?: unknown }).code !== 'P2002'
    ) {
        return false;
    }
    const target = (error as { meta?: { target?: unknown } }).meta?.target;
    if (Array.isArray(target)) return target.includes(field);
    return typeof target === 'string' && target.includes(field);
}

function failClosedAttempt(message: string) {
    return new Smtp2GoAmbiguousSendError(message);
}

function safeErrorMessage(error: unknown) {
    return (error instanceof Error ? error.message : String(error)).slice(
        0,
        2_000
    );
}
