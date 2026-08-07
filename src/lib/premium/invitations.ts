import { createHash, createHmac, randomUUID } from 'node:crypto';
import { render } from 'react-email';
import { Prisma } from '@prisma/client';

import PremiumInvitationEmail from '@/emails/PremiumInvitationEmail';
import { prisma } from '@/lib/prisma';
import { appUrl } from '@/lib/stripe';
import {
    sendSmtp2GoEmail,
    Smtp2GoAmbiguousSendError,
} from '@/lib/notifications/smtp2go';
import { reconcileBillingAccountInTransaction } from '@/lib/services/billingAccounts';
import { scheduleAutoAnalysisWakeup } from '@/lib/services/autoAnalysisBacklog';
import type {
    PremiumDeliveryResult,
} from '@/lib/premium/adminContracts';

export const PREMIUM_INVITATION_LIFETIME_MS = 14 * 24 * 60 * 60 * 1_000;
const DELIVERY_LEASE_MS = 2 * 60 * 1_000;
const MAX_EMAIL_LENGTH = 254;
const MAX_TOKEN_LENGTH = 200;
const MAX_TRANSACTION_ATTEMPTS = 3;
const SIMPLE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeAccountEmail(value: string) {
    return value.trim().toLowerCase();
}

export class PremiumInvitationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PremiumInvitationError';
    }
}

export function validateInvitationEmail(value: string) {
    const email = value.trim();
    if (
        email.length === 0 ||
        email.length > MAX_EMAIL_LENGTH ||
        !SIMPLE_EMAIL.test(email)
    ) {
        throw new PremiumInvitationError('Enter a valid email address');
    }
    return { email, normalized: normalizeAccountEmail(email) };
}

export function premiumInvitationTokenHash(token: string) {
    return createHash('sha256').update(token).digest('hex');
}

/**
 * Invitation tokens are deterministic per invitation generation so an
 * ambiguous provider response can be retried without invalidating a link that
 * may already be in flight. Only the hash is persisted in Postgres.
 */
export function premiumInvitationToken(
    invitationId: string,
    generation: number
) {
    if (!Number.isInteger(generation) || generation < 1) {
        throw new PremiumInvitationError('Invalid invitation generation');
    }
    const signature = createHmac('sha256', invitationTokenSecret())
        .update(`backranq-premium-invitation:v1:${invitationId}:${generation}`)
        .digest('base64url');
    return `${invitationId}.${generation}.${signature}`;
}

export async function invitationPreview(token: string) {
    if (!validTokenInput(token)) return null;
    return prisma.premiumInvitation.findUnique({
        where: { tokenHash: premiumInvitationTokenHash(token) },
        select: {
            id: true,
            email: true,
            plan: true,
            expiresAt: true,
            acceptedAt: true,
            acceptedById: true,
            revokedAt: true,
            activeKey: true,
        },
    });
}

export async function acceptPremiumInvitation(args: {
    token: string;
    userId: string;
    now?: Date;
}) {
    if (!validTokenInput(args.token)) {
        throw new PremiumInvitationError('Invitation is invalid');
    }
    const now = args.now ?? new Date();
    const result = await runWithWriteConflictRetry(() =>
        prisma.$transaction(
            async (tx) => {
                const user = await tx.user.findUnique({
                    where: { id: args.userId },
                    select: { id: true, email: true },
                });
                if (!user?.email) {
                    throw new PremiumInvitationError(
                        'Sign in with the invited email address to continue'
                    );
                }
                const invitation = await tx.premiumInvitation.findUnique({
                    where: {
                        tokenHash: premiumInvitationTokenHash(args.token),
                    },
                });
                if (!invitation) {
                    throw new PremiumInvitationError('Invitation is invalid');
                }
                if (
                    invitation.acceptedAt &&
                    invitation.acceptedById === user.id
                ) {
                    const account = await reconcileBillingAccountInTransaction({
                        tx,
                        userId: user.id,
                        now,
                    });
                    return { userId: user.id, account };
                }
                if (
                    invitation.revokedAt ||
                    !invitation.activeKey ||
                    invitation.expiresAt <= now
                ) {
                    throw new PremiumInvitationError(
                        'Invitation has expired or was revoked'
                    );
                }
                if (
                    normalizeAccountEmail(user.email) !==
                    invitation.emailNormalized
                ) {
                    throw new PremiumInvitationError(
                        'This invitation belongs to a different email address'
                    );
                }

                await tx.planGrant.upsert({
                    where: { invitationId: invitation.id },
                    update: {},
                    create: {
                        userId: user.id,
                        plan: invitation.plan,
                        source: 'ADMIN_INVITATION',
                        invitationId: invitation.id,
                        grantedById: invitation.invitedById,
                        startsAt: now,
                        note: `Accepted invitation for ${invitation.emailNormalized}`,
                    },
                });
                const accepted = await tx.premiumInvitation.updateMany({
                    where: {
                        id: invitation.id,
                        activeKey: invitation.activeKey,
                        acceptedAt: null,
                        revokedAt: null,
                    },
                    data: {
                        activeKey: null,
                        acceptedById: user.id,
                        acceptedAt: now,
                    },
                });
                if (accepted.count !== 1) {
                    throw writeConflict();
                }
                const account = await reconcileBillingAccountInTransaction({
                    tx,
                    userId: user.id,
                    now,
                });
                return { userId: user.id, account };
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
        )
    );

    scheduleAutoAnalysisWakeup(result.userId, 'billing');
    return result.account;
}

/**
 * Claims and sends exactly one token generation. A newer generation cannot be
 * created while this lease is live, and every completion is a generation/lease
 * compare-and-set, so an old worker can never overwrite newer delivery state.
 */
export async function deliverPremiumInvitationGeneration(args: {
    invitationId: string;
    generation: number;
    now?: Date;
}): Promise<PremiumDeliveryResult> {
    const now = args.now ?? new Date();
    const leaseToken = randomUUID();
    const leaseUntil = new Date(now.getTime() + DELIVERY_LEASE_MS);
    const claimed = await prisma.premiumInvitation.updateMany({
        where: {
            id: args.invitationId,
            deliveryGeneration: args.generation,
            deliveryStatus: { in: ['PENDING', 'SENDING'] },
            activeKey: { not: null },
            acceptedAt: null,
            revokedAt: null,
            expiresAt: { gt: now },
            OR: [
                { deliveryStatus: 'PENDING' },
                { deliveryLeaseUntil: { lte: now } },
            ],
        },
        data: {
            deliveryStatus: 'SENDING',
            deliveryLeaseToken: leaseToken,
            deliveryLeaseUntil: leaseUntil,
            lastDeliveryAttemptAt: now,
            deliveryAttempts: { increment: 1 },
            lastEmailError: null,
        },
    });
    if (claimed.count !== 1) {
        return currentDeliveryResult(args, false);
    }

    const invitation = await prisma.premiumInvitation.findUnique({
        where: { id: args.invitationId },
        select: {
            id: true,
            email: true,
            deliveryGeneration: true,
            deliveryLeaseToken: true,
        },
    });
    if (
        !invitation ||
        invitation.deliveryGeneration !== args.generation ||
        invitation.deliveryLeaseToken !== leaseToken
    ) {
        return currentDeliveryResult(args, false);
    }

    const token = premiumInvitationToken(invitation.id, args.generation);
    try {
        const providerEmailId = await sendInvitationEmail({
            invitationId: invitation.id,
            email: invitation.email,
            token,
        });
        return completeDelivery({
            ...args,
            leaseToken,
            status: 'SENT',
            providerEmailId,
            message: null,
        });
    } catch (error) {
        const ambiguous = error instanceof Smtp2GoAmbiguousSendError;
        const message = safeErrorMessage(error);
        return completeDelivery({
            ...args,
            leaseToken,
            status: ambiguous ? 'AMBIGUOUS' : 'FAILED',
            providerEmailId: null,
            message,
        });
    }
}

async function completeDelivery(args: {
    invitationId: string;
    generation: number;
    leaseToken: string;
    status: 'SENT' | 'AMBIGUOUS' | 'FAILED';
    providerEmailId: string | null;
    message: string | null;
}) {
    const completedAt = new Date();
    const updated = await prisma.premiumInvitation.updateMany({
        where: {
            id: args.invitationId,
            deliveryGeneration: args.generation,
            deliveryStatus: 'SENDING',
            deliveryLeaseToken: args.leaseToken,
        },
        data: {
            deliveryStatus: args.status,
            deliveryLeaseToken: null,
            deliveryLeaseUntil: null,
            emailSentAt: args.status === 'SENT' ? completedAt : null,
            providerEmailId: args.providerEmailId,
            lastEmailError: args.message,
        },
    });
    if (updated.count !== 1) {
        return currentDeliveryResult(args, true);
    }
    return {
        invitationId: args.invitationId,
        generation: args.generation,
        status: args.status,
        attempted: true,
        message: args.message,
    } satisfies PremiumDeliveryResult;
}

async function currentDeliveryResult(
    args: { invitationId: string; generation: number },
    attempted: boolean
): Promise<PremiumDeliveryResult> {
    const current = await prisma.premiumInvitation.findUnique({
        where: { id: args.invitationId },
        select: {
            deliveryGeneration: true,
            deliveryStatus: true,
            lastEmailError: true,
        },
    });
    if (!current) {
        throw new PremiumInvitationError('Invitation no longer exists');
    }
    return {
        invitationId: args.invitationId,
        generation: current.deliveryGeneration,
        status: current.deliveryStatus,
        attempted,
        message:
            current.deliveryGeneration === args.generation
                ? current.lastEmailError
                : 'A newer invitation generation is already active',
    };
}

async function sendInvitationEmail(args: {
    invitationId: string;
    email: string;
    token: string;
}) {
    const from = process.env.BACKRANQ_EMAIL_FROM;
    if (!from) throw new Error('BACKRANQ_EMAIL_FROM is not configured');
    const actionUrl = `${appUrl()}/invite/${encodeURIComponent(args.token)}`;
    const html = await render(PremiumInvitationEmail({ actionUrl }));
    const text = [
        'Your Backranq Pro invitation',
        '',
        'You have been invited to use Backranq Pro at no cost.',
        'Sign in with this email address and accept the invitation:',
        actionUrl,
        '',
        'This invitation expires in 14 days.',
    ].join('\n');
    return sendSmtp2GoEmail({
        from,
        to: args.email,
        subject: 'Your Backranq Pro invitation',
        html,
        text,
        headers: {
            'X-Backranq-Premium-Invitation-Id': args.invitationId,
        },
    });
}

export async function runWithWriteConflictRetry<T>(
    operation: () => Promise<T>
): Promise<T> {
    for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
        try {
            return await operation();
        } catch (error) {
            if (attempt < MAX_TRANSACTION_ATTEMPTS && isWriteConflict(error)) {
                continue;
            }
            throw error;
        }
    }
    throw new Error('Premium transaction retry limit exceeded');
}

function validTokenInput(token: string) {
    return token.length > 0 && token.length <= MAX_TOKEN_LENGTH;
}

function invitationTokenSecret() {
    const secret =
        process.env.PREMIUM_INVITATION_TOKEN_SECRET ??
        process.env.AUTH_SECRET ??
        process.env.NEXTAUTH_SECRET;
    if (!secret) {
        throw new PremiumInvitationError(
            'Premium invitation token secret is not configured'
        );
    }
    return secret;
}

function safeErrorMessage(error: unknown) {
    return (error instanceof Error ? error.message : 'Unknown email error').slice(
        0,
        1_000
    );
}

function isWriteConflict(error: unknown) {
    return (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: unknown }).code === 'P2034'
    );
}

function writeConflict() {
    return Object.assign(new Error('Concurrent Premium mutation conflict'), {
        code: 'P2034',
    });
}
