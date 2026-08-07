import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';

import { runAuditedAdminMutation } from '@/lib/admin/audit';
import type { AdminMutationContext } from '@/lib/admin/http';
import {
    deliverPremiumInvitationGeneration,
    premiumInvitationToken,
    premiumInvitationTokenHash,
    PREMIUM_INVITATION_LIFETIME_MS,
    runWithWriteConflictRetry,
    validateInvitationEmail,
} from '@/lib/premium/invitations';
import type {
    PremiumAdminCommand,
    PremiumAdminCommandReceipt,
    PremiumAdminCommandResult,
} from '@/lib/premium/adminContracts';
import { reconcileBillingAccountInTransaction } from '@/lib/services/billingAccounts';

export class PremiumAdminCommandConflict extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PremiumAdminCommandConflict';
    }
}

export async function executePremiumAdminCommand(args: {
    context: AdminMutationContext;
    command: PremiumAdminCommand;
    now?: Date;
}): Promise<PremiumAdminCommandReceipt> {
    const now = args.now ?? new Date();
    const receipt = await executeAuditedCommand({ ...args, now });
    if (
        receipt.result.command !== args.command.type ||
        receipt.result.commandFingerprint !== commandFingerprint(args.command)
    ) {
        throw new PremiumAdminCommandConflict(
            'This idempotency key was already used for a different Premium command'
        );
    }
    const generation = receipt.result.deliveryGeneration;
    const invitationId = receipt.result.invitationId;
    const delivery =
        generation !== null && invitationId !== null
            ? await deliverPremiumInvitationGeneration({
                  invitationId,
                  generation,
                  now,
              })
            : null;
    return { ...receipt, delivery };
}

async function executeAuditedCommand(args: {
    context: AdminMutationContext;
    command: PremiumAdminCommand;
    now: Date;
}) {
    try {
        switch (args.command.type) {
            case 'CREATE_INVITATION':
                return await createInvitation({
                    context: args.context,
                    command: args.command,
                    now: args.now,
                });
            case 'RESEND_INVITATION':
                return await resendInvitation({
                    context: args.context,
                    command: args.command,
                    now: args.now,
                });
            case 'REVOKE_INVITATION':
                return await revokeInvitation({
                    context: args.context,
                    command: args.command,
                    now: args.now,
                });
            case 'REVOKE_GRANT':
                return await revokeGrant({
                    context: args.context,
                    command: args.command,
                    now: args.now,
                });
        }
    } catch (error) {
        if (isUniqueConflict(error)) {
            throw new PremiumAdminCommandConflict(
                'A pending invitation for this email already exists'
            );
        }
        throw error;
    }
}

async function createInvitation(args: {
    context: AdminMutationContext;
    command: Extract<PremiumAdminCommand, { type: 'CREATE_INVITATION' }>;
    now: Date;
}) {
    const address = validateInvitationEmail(args.command.email);
    const invitationId = randomUUID();
    const generation = 1;
    const tokenHash = premiumInvitationTokenHash(
        premiumInvitationToken(invitationId, generation)
    );
    const expiresAt = new Date(
        args.now.getTime() + PREMIUM_INVITATION_LIFETIME_MS
    );

    return auditedWithRetry({
        context: args.context,
        action: 'PREMIUM_INVITATION_CREATE',
        target: { type: 'PremiumInvitation', id: invitationId },
        reason: 'Create complimentary Pro invitation',
        metadata: {
            command: args.command.type,
            emailNormalized: address.normalized,
        },
        mutate: async (tx) => {
            await assertRecipientCanBeInvited(tx, address.normalized, args.now);
            const activeInvitation = await tx.premiumInvitation.findUnique({
                where: { activeKey: address.normalized },
                select: { id: true },
            });
            if (activeInvitation) {
                throw new PremiumAdminCommandConflict(
                    'A pending invitation for this email already exists; use Resend'
                );
            }
            await tx.premiumInvitation.create({
                data: {
                    id: invitationId,
                    email: address.email,
                    emailNormalized: address.normalized,
                    activeKey: address.normalized,
                    tokenHash,
                    plan: 'PRO',
                    invitedById: args.context.principal.userId,
                    expiresAt,
                    deliveryGeneration: generation,
                    deliveryStatus: 'PENDING',
                },
            });
            return commandResult({
                command: args.command,
                targetId: invitationId,
                invitationId,
                deliveryGeneration: generation,
            });
        },
    });
}

async function resendInvitation(args: {
    context: AdminMutationContext;
    command: Extract<PremiumAdminCommand, { type: 'RESEND_INVITATION' }>;
    now: Date;
}) {
    return auditedWithRetry({
        context: args.context,
        action: 'PREMIUM_INVITATION_RESEND',
        target: {
            type: 'PremiumInvitation',
            id: args.command.invitationId,
        },
        reason: 'Resend complimentary Pro invitation',
        metadata: { command: args.command.type },
        mutate: async (tx) => {
            const invitation = await tx.premiumInvitation.findUnique({
                where: { id: args.command.invitationId },
            });
            assertPendingInvitation(invitation);
            assertNoActiveDeliveryLease(invitation, args.now);

            const rotate = invitation.deliveryStatus === 'SENT';
            const generation = rotate
                ? invitation.deliveryGeneration + 1
                : invitation.deliveryGeneration;
            const tokenHash = premiumInvitationTokenHash(
                premiumInvitationToken(invitation.id, generation)
            );
            const expiresAt = new Date(
                args.now.getTime() + PREMIUM_INVITATION_LIFETIME_MS
            );
            const updated = await tx.premiumInvitation.updateMany({
                where: {
                    id: invitation.id,
                    deliveryGeneration: invitation.deliveryGeneration,
                    deliveryStatus: invitation.deliveryStatus,
                    acceptedAt: null,
                    revokedAt: null,
                    activeKey: { not: null },
                },
                data: {
                    tokenHash,
                    expiresAt,
                    deliveryGeneration: generation,
                    deliveryStatus: 'PENDING',
                    deliveryLeaseToken: null,
                    deliveryLeaseUntil: null,
                    emailSentAt: null,
                    providerEmailId: null,
                    lastEmailError: null,
                    invitedById: args.context.principal.userId,
                },
            });
            if (updated.count !== 1) throw writeConflict();
            return commandResult({
                command: args.command,
                targetId: invitation.id,
                invitationId: invitation.id,
                deliveryGeneration: generation,
            });
        },
    });
}

async function revokeInvitation(args: {
    context: AdminMutationContext;
    command: Extract<PremiumAdminCommand, { type: 'REVOKE_INVITATION' }>;
    now: Date;
}) {
    return auditedWithRetry({
        context: args.context,
        action: 'PREMIUM_INVITATION_REVOKE',
        target: {
            type: 'PremiumInvitation',
            id: args.command.invitationId,
        },
        reason: 'Revoke complimentary Pro invitation',
        metadata: { command: args.command.type },
        mutate: async (tx) => {
            const invitation = await tx.premiumInvitation.findUnique({
                where: { id: args.command.invitationId },
            });
            assertPendingInvitation(invitation);
            assertNoActiveDeliveryLease(invitation, args.now);
            const revoked = await tx.premiumInvitation.updateMany({
                where: {
                    id: invitation.id,
                    deliveryGeneration: invitation.deliveryGeneration,
                    acceptedAt: null,
                    revokedAt: null,
                    activeKey: { not: null },
                },
                data: {
                    activeKey: null,
                    revokedAt: args.now,
                    deliveryLeaseToken: null,
                    deliveryLeaseUntil: null,
                },
            });
            if (revoked.count !== 1) throw writeConflict();
            return commandResult({
                command: args.command,
                targetId: invitation.id,
                invitationId: invitation.id,
            });
        },
    });
}

async function revokeGrant(args: {
    context: AdminMutationContext;
    command: Extract<PremiumAdminCommand, { type: 'REVOKE_GRANT' }>;
    now: Date;
}) {
    return auditedWithRetry({
        context: args.context,
        action: 'PREMIUM_GRANT_REVOKE',
        target: { type: 'PlanGrant', id: args.command.grantId },
        reason: 'Revoke complimentary Pro access',
        metadata: { command: args.command.type },
        mutate: async (tx) => {
            const grant = await tx.planGrant.findUnique({
                where: { id: args.command.grantId },
                select: { id: true, userId: true, revokedAt: true, note: true },
            });
            if (!grant || grant.revokedAt) {
                throw new PremiumAdminCommandConflict(
                    'Premium access is no longer active'
                );
            }
            const revoked = await tx.planGrant.updateMany({
                where: { id: grant.id, revokedAt: null },
                data: {
                    revokedAt: args.now,
                    note: [
                        grant.note,
                        `Revoked by administrator ${args.context.principal.userId}`,
                    ]
                        .filter(Boolean)
                        .join(' · '),
                },
            });
            if (revoked.count !== 1) throw writeConflict();
            await reconcileBillingAccountInTransaction({
                tx,
                userId: grant.userId,
                now: args.now,
            });
            return commandResult({
                command: args.command,
                targetId: grant.id,
                grantId: grant.id,
            });
        },
    });
}

async function assertRecipientCanBeInvited(
    tx: Prisma.TransactionClient,
    emailNormalized: string,
    now: Date
) {
    const existingUser = await tx.user.findFirst({
        where: { email: { equals: emailNormalized, mode: 'insensitive' } },
        select: { id: true },
    });
    if (!existingUser) return;
    const [activeAdmin, activeGrant] = await Promise.all([
        tx.adminMembership.findUnique({
            where: { userId: existingUser.id },
            select: { active: true },
        }),
        tx.planGrant.findFirst({
            where: {
                userId: existingUser.id,
                revokedAt: null,
                startsAt: { lte: now },
                OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
            },
            select: { id: true },
        }),
    ]);
    if (activeAdmin?.active) {
        throw new PremiumAdminCommandConflict(
            'This account already has administrator Pro access'
        );
    }
    if (activeGrant) {
        throw new PremiumAdminCommandConflict(
            'This account already has complimentary Pro access'
        );
    }
}

function assertPendingInvitation(
    invitation:
        | {
              id: string;
              activeKey: string | null;
              acceptedAt: Date | null;
              revokedAt: Date | null;
          }
        | null
): asserts invitation is NonNullable<typeof invitation> & {
    deliveryGeneration: number;
    deliveryStatus: 'PENDING' | 'SENDING' | 'SENT' | 'AMBIGUOUS' | 'FAILED';
    deliveryLeaseUntil: Date | null;
} {
    if (
        !invitation ||
        !invitation.activeKey ||
        invitation.acceptedAt ||
        invitation.revokedAt
    ) {
        throw new PremiumAdminCommandConflict(
            'Invitation is no longer pending'
        );
    }
}

function assertNoActiveDeliveryLease(
    invitation: {
        deliveryStatus: string;
        deliveryLeaseUntil: Date | null;
    },
    now: Date
) {
    if (
        invitation.deliveryStatus === 'SENDING' &&
        invitation.deliveryLeaseUntil &&
        invitation.deliveryLeaseUntil > now
    ) {
        throw new PremiumAdminCommandConflict(
            'Invitation email delivery is in progress; try again shortly'
        );
    }
}

function commandResult(args: {
    command: PremiumAdminCommand;
    targetId: string;
    invitationId?: string;
    grantId?: string;
    deliveryGeneration?: number;
}): PremiumAdminCommandResult {
    return {
        command: args.command.type,
        commandFingerprint: commandFingerprint(args.command),
        targetId: args.targetId,
        invitationId: args.invitationId ?? null,
        grantId: args.grantId ?? null,
        deliveryGeneration: args.deliveryGeneration ?? null,
    };
}

function commandFingerprint(command: PremiumAdminCommand) {
    const target =
        command.type === 'CREATE_INVITATION'
            ? command.email.trim().toLowerCase()
            : command.type === 'REVOKE_GRANT'
              ? command.grantId
              : command.invitationId;
    return createHash('sha256')
        .update(`premium-admin-command:v1:${command.type}:${target}`)
        .digest('hex');
}

function auditedWithRetry<T>(
    args: Parameters<typeof runAuditedAdminMutation<T>>[0]
) {
    return runWithWriteConflictRetry(() => runAuditedAdminMutation(args));
}

function isUniqueConflict(error: unknown) {
    return (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: unknown }).code === 'P2002'
    );
}

function writeConflict() {
    return Object.assign(new Error('Concurrent Premium mutation conflict'), {
        code: 'P2034',
    });
}
