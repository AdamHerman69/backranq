import { createHash, randomBytes } from 'node:crypto';
import { render } from 'react-email';
import { Prisma } from '@prisma/client';
import PremiumInvitationEmail from '@/emails/PremiumInvitationEmail';
import { prisma } from '@/lib/prisma';
import { appUrl } from '@/lib/stripe';
import { sendSmtp2GoEmail } from '@/lib/notifications/smtp2go';
import { reconcileBillingAccountInTransaction } from '@/lib/services/billingAccounts';
import { scheduleAutoAnalysisWakeup } from '@/lib/services/autoAnalysisBacklog';

const INVITATION_LIFETIME_MS = 14 * 24 * 60 * 60 * 1_000;
const MAX_EMAIL_LENGTH = 254;
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

export async function createAndSendPremiumInvitation(args: {
    invitedById: string;
    adminMembershipId: string;
    auditAction:
        | 'PREMIUM_INVITATION_CREATE'
        | 'PREMIUM_INVITATION_RESEND';
    email: string;
    now?: Date;
}) {
    const now = args.now ?? new Date();
    const address = validateInvitationEmail(args.email);
    const token = randomBytes(32).toString('base64url');
    const tokenHash = premiumInvitationTokenHash(token);
    const expiresAt = new Date(now.getTime() + INVITATION_LIFETIME_MS);

    const invitation = await runSerializable(async (tx) => {
        const existingUser = await tx.user.findFirst({
            where: {
                email: { equals: address.normalized, mode: 'insensitive' },
            },
            select: { id: true },
        });
        if (existingUser) {
            const activeAdmin = await tx.adminMembership.findUnique({
                where: { userId: existingUser.id },
                select: { active: true },
            });
            if (activeAdmin?.active) {
                throw new PremiumInvitationError(
                    'This account already has administrator Pro access'
                );
            }
            const activeGrant = await tx.planGrant.findFirst({
                where: {
                    userId: existingUser.id,
                    revokedAt: null,
                    startsAt: { lte: now },
                    OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
                },
                select: { id: true },
            });
            if (activeGrant) {
                throw new PremiumInvitationError(
                    'This account already has complimentary Pro access'
                );
            }
        }

        const invitation = await tx.premiumInvitation.upsert({
            where: { activeKey: address.normalized },
            update: {
                email: address.email,
                emailNormalized: address.normalized,
                tokenHash,
                plan: 'PRO',
                invitedById: args.invitedById,
                expiresAt,
                acceptedById: null,
                acceptedAt: null,
                revokedAt: null,
                emailSentAt: null,
                providerEmailId: null,
                lastEmailError: null,
            },
            create: {
                email: address.email,
                emailNormalized: address.normalized,
                activeKey: address.normalized,
                tokenHash,
                plan: 'PRO',
                invitedById: args.invitedById,
                expiresAt,
            },
        });
        await tx.adminAuditLog.create({
            data: {
                adminMembershipId: args.adminMembershipId,
                action: args.auditAction,
                targetType: 'PremiumInvitation',
                targetId: invitation.id,
                metadata: {
                    emailNormalized: address.normalized,
                    expiresAt: expiresAt.toISOString(),
                },
            },
        });
        return invitation;
    });

    try {
        const providerEmailId = await sendInvitationEmail({
            invitationId: invitation.id,
            email: invitation.email,
            token,
        });
        return prisma.premiumInvitation.update({
            where: { id: invitation.id },
            data: {
                emailSentAt: new Date(),
                providerEmailId,
                lastEmailError: null,
            },
        });
    } catch (error) {
        const message = safeErrorMessage(error);
        await prisma.premiumInvitation.update({
            where: { id: invitation.id },
            data: { lastEmailError: message },
        });
        throw new PremiumInvitationError(
            'The invitation was saved, but its email could not be confirmed as sent'
        );
    }
}

export async function revokePremiumInvitation(args: {
    invitationId: string;
    adminMembershipId: string;
}) {
    const result = await runSerializable(async (tx) => {
        const update = await tx.premiumInvitation.updateMany({
            where: {
                id: args.invitationId,
                activeKey: { not: null },
                acceptedAt: null,
                revokedAt: null,
            },
            data: {
                activeKey: null,
                revokedAt: new Date(),
            },
        });
        if (update.count === 1) {
            await tx.adminAuditLog.create({
                data: {
                    adminMembershipId: args.adminMembershipId,
                    action: 'PREMIUM_INVITATION_REVOKE',
                    targetType: 'PremiumInvitation',
                    targetId: args.invitationId,
                },
            });
        }
        return update;
    });
    if (result.count !== 1) {
        throw new PremiumInvitationError('Invitation is no longer pending');
    }
}

export async function invitationPreview(token: string) {
    if (!token || token.length > 200) return null;
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
    const now = args.now ?? new Date();
    const result = await runSerializable(async (tx) => {
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
        await tx.premiumInvitation.update({
            where: { id: invitation.id },
            data: {
                activeKey: null,
                acceptedById: user.id,
                acceptedAt: now,
            },
        });
        const account = await reconcileBillingAccountInTransaction({
            tx,
            userId: user.id,
            now,
        });
        return { userId: user.id, account };
    });

    scheduleAutoAnalysisWakeup(result.userId, 'billing');
    return result.account;
}

export async function revokePlanGrant(args: {
    grantId: string;
    revokedById: string;
    adminMembershipId: string;
    now?: Date;
}) {
    const now = args.now ?? new Date();
    const result = await runSerializable(async (tx) => {
        const grant = await tx.planGrant.findUnique({
            where: { id: args.grantId },
            select: { id: true, userId: true, revokedAt: true, note: true },
        });
        if (!grant || grant.revokedAt) {
            throw new PremiumInvitationError('Premium access is no longer active');
        }
        await tx.planGrant.update({
            where: { id: grant.id },
            data: {
                revokedAt: now,
                note: [
                    grant.note,
                    `Revoked by administrator ${args.revokedById}`,
                ]
                    .filter(Boolean)
                    .join(' · '),
            },
        });
        await tx.adminAuditLog.create({
            data: {
                adminMembershipId: args.adminMembershipId,
                action: 'PREMIUM_GRANT_REVOKE',
                targetType: 'PlanGrant',
                targetId: grant.id,
                metadata: { userId: grant.userId },
            },
        });
        const account = await reconcileBillingAccountInTransaction({
            tx,
            userId: grant.userId,
            now,
        });
        return { userId: grant.userId, account };
    });
    return result.account;
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

function safeErrorMessage(error: unknown) {
    return (error instanceof Error ? error.message : 'Unknown email error').slice(
        0,
        1_000
    );
}

async function runSerializable<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>
) {
    return prisma.$transaction(operation, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
}
