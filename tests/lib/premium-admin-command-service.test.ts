import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockPrismaModule, prismaMock } from '../helpers/route-mocks';

const { runAuditedMock, deliveryMock, reconcileMock } = vi.hoisted(() => ({
    runAuditedMock: vi.fn(),
    deliveryMock: vi.fn(),
    reconcileMock: vi.fn(),
}));

vi.mock('@/lib/admin/audit', () => ({
    runAuditedAdminMutation: runAuditedMock,
}));
vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));
vi.mock('@/lib/premium/invitations', () => ({
    PREMIUM_INVITATION_LIFETIME_MS: 14 * 24 * 60 * 60 * 1_000,
    validateInvitationEmail: (value: string) => ({
        email: value.trim(),
        normalized: value.trim().toLowerCase(),
    }),
    premiumInvitationToken: (id: string, generation: number) =>
        `token:${id}:${generation}`,
    premiumInvitationTokenHash: (token: string) => `hash:${token}`,
    deliverPremiumInvitationGeneration: deliveryMock,
    runWithWriteConflictRetry: async (operation: () => Promise<unknown>) => {
        for (let attempt = 1; attempt <= 3; attempt += 1) {
            try {
                return await operation();
            } catch (error) {
                if (
                    attempt < 3 &&
                    typeof error === 'object' &&
                    error !== null &&
                    'code' in error &&
                    error.code === 'P2034'
                ) {
                    continue;
                }
                throw error;
            }
        }
    },
}));
vi.mock('@/lib/services/billingAccounts', () => ({
    reconcileBillingAccountInTransaction: reconcileMock,
}));

import {
    executePremiumAdminCommand,
    PremiumAdminCommandConflict,
} from '@/lib/premium/adminCommandService';

const receipts = new Map<string, unknown>();
const now = new Date('2026-08-07T00:00:00Z');
const invitationId = '11111111-1111-4111-8111-111111111111';
const grantId = '22222222-2222-4222-8222-222222222222';

function context(idempotencyKey = 'membership-1:premium-command-0001') {
    return {
        principal: {
            membershipId: 'membership-1',
            userId: '33333333-3333-4333-8333-333333333333',
            role: 'ADMIN' as const,
            capabilities: ['PREMIUM_MANAGE'] as const,
        },
        idempotencyKey,
        requestId: 'request-1',
        ipHash: 'ip-hash',
        userAgentHash: 'ua-hash',
    };
}

function invitation(overrides: Record<string, unknown> = {}) {
    return {
        id: invitationId,
        email: 'friend@example.com',
        emailNormalized: 'friend@example.com',
        activeKey: 'friend@example.com',
        tokenHash: 'hash:old-token',
        plan: 'PRO',
        invitedById: 'admin-user-1',
        acceptedById: null,
        expiresAt: new Date('2026-08-21T00:00:00Z'),
        acceptedAt: null,
        revokedAt: null,
        deliveryGeneration: 1,
        deliveryStatus: 'SENT',
        deliveryAttempts: 1,
        deliveryLeaseToken: null,
        deliveryLeaseUntil: null,
        lastDeliveryAttemptAt: now,
        emailSentAt: now,
        providerEmailId: 'smtp-1',
        lastEmailError: null,
        createdAt: now,
        updatedAt: now,
        ...overrides,
    };
}

describe('Premium admin command service', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        receipts.clear();
        mockPrismaModule();
        runAuditedMock.mockImplementation(async (args: {
            context: { idempotencyKey: string };
            mutate: (tx: typeof prismaMock) => Promise<unknown>;
        }) => {
            if (receipts.has(args.context.idempotencyKey)) {
                return {
                    result: receipts.get(args.context.idempotencyKey),
                    replayed: true,
                };
            }
            const result = await args.mutate(prismaMock);
            receipts.set(args.context.idempotencyKey, result);
            return { result, replayed: false };
        });
        deliveryMock.mockImplementation(
            async (args: { invitationId: string; generation: number }) => ({
                ...args,
                status: 'SENT',
                attempted: true,
                message: null,
            })
        );
        reconcileMock.mockResolvedValue({ plan: 'FREE' });
        prismaMock.user.findFirst.mockResolvedValue(null);
        prismaMock.premiumInvitation.findUnique.mockResolvedValue(null);
        prismaMock.premiumInvitation.create.mockResolvedValue({ id: invitationId });
        prismaMock.premiumInvitation.updateMany.mockResolvedValue({ count: 1 });
        prismaMock.planGrant.updateMany.mockResolvedValue({ count: 1 });
    });

    it('creates through an idempotent audited receipt without persisting the raw token', async () => {
        const mutationContext = context();

        const first = await executePremiumAdminCommand({
            context: mutationContext,
            command: { type: 'CREATE_INVITATION', email: ' Friend@Example.com ' },
            now,
        });
        const replay = await executePremiumAdminCommand({
            context: mutationContext,
            command: { type: 'CREATE_INVITATION', email: ' Friend@Example.com ' },
            now,
        });

        expect(first.replayed).toBe(false);
        expect(replay).toMatchObject({ replayed: true, result: first.result });
        expect(prismaMock.premiumInvitation.create).toHaveBeenCalledOnce();
        const create = prismaMock.premiumInvitation.create.mock.calls[0]?.[0] as {
            data: { tokenHash: string };
        };
        expect(create.data.tokenHash).toMatch(/^hash:token:/);
        expect(JSON.stringify(receipts.get(mutationContext.idempotencyKey))).not.toContain(
            'hash:token:'
        );
        expect(runAuditedMock).toHaveBeenCalledWith(
            expect.objectContaining({
                action: 'PREMIUM_INVITATION_CREATE',
                reason: 'Create complimentary Pro invitation',
                metadata: expect.objectContaining({
                    emailNormalized: 'friend@example.com',
                }),
            })
        );
    });

    it('rejects reuse of an idempotency key for a different command payload', async () => {
        const mutationContext = context('membership-1:premium-command-reused');

        await executePremiumAdminCommand({
            context: mutationContext,
            command: { type: 'CREATE_INVITATION', email: 'first@example.com' },
            now,
        });

        await expect(
            executePremiumAdminCommand({
                context: mutationContext,
                command: {
                    type: 'CREATE_INVITATION',
                    email: 'different@example.com',
                },
                now,
            })
        ).rejects.toThrow('already used for a different Premium command');
        expect(prismaMock.premiumInvitation.create).toHaveBeenCalledOnce();
    });

    it('resends only the server-loaded invitation ID and rotates a confirmed generation', async () => {
        prismaMock.premiumInvitation.findUnique.mockResolvedValue(invitation());

        const receipt = await executePremiumAdminCommand({
            context: context('membership-1:premium-command-0002'),
            command: { type: 'RESEND_INVITATION', invitationId },
            now,
        });

        expect(prismaMock.premiumInvitation.findUnique).toHaveBeenCalledWith({
            where: { id: invitationId },
        });
        expect(prismaMock.premiumInvitation.updateMany).toHaveBeenCalledWith({
            where: expect.objectContaining({
                id: invitationId,
                deliveryGeneration: 1,
                deliveryStatus: 'SENT',
            }),
            data: expect.objectContaining({
                deliveryGeneration: 2,
                deliveryStatus: 'PENDING',
                tokenHash: `hash:token:${invitationId}:2`,
            }),
        });
        expect(receipt.result.deliveryGeneration).toBe(2);
        expect(deliveryMock).toHaveBeenCalledWith({
            invitationId,
            generation: 2,
            now,
        });
    });

    it('retries failed or ambiguous delivery with the same still-valid generation', async () => {
        prismaMock.premiumInvitation.findUnique.mockResolvedValue(
            invitation({
                deliveryGeneration: 3,
                deliveryStatus: 'AMBIGUOUS',
                emailSentAt: null,
            })
        );

        await executePremiumAdminCommand({
            context: context('membership-1:premium-command-0003'),
            command: { type: 'RESEND_INVITATION', invitationId },
            now,
        });

        expect(prismaMock.premiumInvitation.updateMany).toHaveBeenCalledWith({
            where: expect.objectContaining({ deliveryGeneration: 3 }),
            data: expect.objectContaining({
                deliveryGeneration: 3,
                tokenHash: `hash:token:${invitationId}:3`,
                deliveryStatus: 'PENDING',
            }),
        });
    });

    it('rejects resend and revoke while a delivery lease is active', async () => {
        prismaMock.premiumInvitation.findUnique.mockResolvedValue(
            invitation({
                deliveryStatus: 'SENDING',
                deliveryLeaseUntil: new Date('2026-08-07T00:01:00Z'),
            })
        );

        await expect(
            executePremiumAdminCommand({
                context: context('membership-1:premium-command-0004'),
                command: { type: 'RESEND_INVITATION', invitationId },
                now,
            })
        ).rejects.toBeInstanceOf(PremiumAdminCommandConflict);
        await expect(
            executePremiumAdminCommand({
                context: context('membership-1:premium-command-0005'),
                command: { type: 'REVOKE_INVITATION', invitationId },
                now,
            })
        ).rejects.toBeInstanceOf(PremiumAdminCommandConflict);
        expect(prismaMock.premiumInvitation.updateMany).not.toHaveBeenCalled();
        expect(deliveryMock).not.toHaveBeenCalled();
    });

    it('makes invitation revoke idempotent through the audit receipt', async () => {
        const mutationContext = context('membership-1:premium-command-0006');
        prismaMock.premiumInvitation.findUnique.mockResolvedValue(invitation());

        const first = await executePremiumAdminCommand({
            context: mutationContext,
            command: { type: 'REVOKE_INVITATION', invitationId },
            now,
        });
        const replay = await executePremiumAdminCommand({
            context: mutationContext,
            command: { type: 'REVOKE_INVITATION', invitationId },
            now,
        });

        expect(first.replayed).toBe(false);
        expect(replay.replayed).toBe(true);
        expect(prismaMock.premiumInvitation.updateMany).toHaveBeenCalledOnce();
        expect(runAuditedMock).toHaveBeenLastCalledWith(
            expect.objectContaining({
                action: 'PREMIUM_INVITATION_REVOKE',
                target: { type: 'PremiumInvitation', id: invitationId },
            })
        );
    });

    it('makes grant revoke idempotent and reconciles exactly once', async () => {
        const mutationContext = context('membership-1:premium-command-0007');
        prismaMock.planGrant.findUnique.mockResolvedValue({
            id: grantId,
            userId: '44444444-4444-4444-8444-444444444444',
            revokedAt: null,
            note: null,
        });

        const first = await executePremiumAdminCommand({
            context: mutationContext,
            command: { type: 'REVOKE_GRANT', grantId },
            now,
        });
        const replay = await executePremiumAdminCommand({
            context: mutationContext,
            command: { type: 'REVOKE_GRANT', grantId },
            now,
        });

        expect(first.replayed).toBe(false);
        expect(replay.replayed).toBe(true);
        expect(prismaMock.planGrant.updateMany).toHaveBeenCalledOnce();
        expect(reconcileMock).toHaveBeenCalledOnce();
        expect(runAuditedMock).toHaveBeenLastCalledWith(
            expect.objectContaining({
                action: 'PREMIUM_GRANT_REVOKE',
                target: { type: 'PlanGrant', id: grantId },
            })
        );
    });
});
