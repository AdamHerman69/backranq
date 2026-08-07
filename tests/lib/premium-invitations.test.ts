import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockPrismaModule, prismaMock } from '../helpers/route-mocks';

const sendEmailMock = vi.fn();
const renderMock = vi.fn();
const scheduleWakeupMock = vi.fn();

class AmbiguousSendError extends Error {}

async function importInvitations() {
    vi.resetModules();
    mockPrismaModule();
    vi.doMock('react-email', () => ({ render: renderMock }));
    vi.doMock('@/emails/PremiumInvitationEmail', () => ({
        default: vi.fn(() => null),
    }));
    vi.doMock('@/lib/stripe', () => ({
        appUrl: () => 'https://backranq.example',
    }));
    vi.doMock('@/lib/notifications/smtp2go', () => ({
        sendSmtp2GoEmail: sendEmailMock,
        Smtp2GoAmbiguousSendError: AmbiguousSendError,
    }));
    vi.doMock('@/lib/services/autoAnalysisBacklog', () => ({
        scheduleAutoAnalysisWakeup: scheduleWakeupMock,
    }));
    prismaMock.$transaction.mockImplementation(
        async (callback: unknown) =>
            (callback as (tx: typeof prismaMock) => Promise<unknown>)(
                prismaMock
            )
    );
    return import('@/lib/premium/invitations');
}

function invitation(overrides: Record<string, unknown> = {}) {
    return {
        id: '11111111-1111-4111-8111-111111111111',
        email: 'Friend@Example.com',
        emailNormalized: 'friend@example.com',
        activeKey: 'friend@example.com',
        tokenHash: 'stored-hash',
        plan: 'PRO',
        invitedById: '22222222-2222-4222-8222-222222222222',
        acceptedById: null,
        expiresAt: new Date('2026-08-20T00:00:00Z'),
        acceptedAt: null,
        revokedAt: null,
        deliveryGeneration: 1,
        deliveryStatus: 'PENDING',
        deliveryAttempts: 0,
        deliveryLeaseToken: null,
        deliveryLeaseUntil: null,
        lastDeliveryAttemptAt: null,
        emailSentAt: null,
        providerEmailId: null,
        lastEmailError: null,
        createdAt: new Date('2026-08-06T00:00:00Z'),
        updatedAt: new Date('2026-08-06T00:00:00Z'),
        ...overrides,
    };
}

function freeAccount(overrides: Record<string, unknown> = {}) {
    return {
        id: 'billing-1',
        userId: 'user-1',
        plan: 'FREE',
        planSource: 'FREE',
        stripePlan: 'FREE',
        stripeCustomerId: null,
        stripeSubscriptionId: null,
        stripeSubscriptionStatus: null,
        stripePriceId: null,
        stripeCurrentPeriodEnd: null,
        stripeLastEventCreatedAt: null,
        stripeLastEventId: null,
        serverCreditsBalance: 100,
        monthlyServerCreditsUsed: 0,
        serverCreditsPeriodStart: new Date('2026-08-01T00:00:00Z'),
        serverCreditsRenewAt: new Date('2026-09-01T00:00:00Z'),
        monthlyServerCreditsLimit: 100,
        autoAnalysisMonthlyGameLimit: 50,
        autoAnalysisDailyGameLimit: 10,
        stopWhenCreditsBelow: 0,
        createdAt: new Date('2026-08-01T00:00:00Z'),
        updatedAt: new Date('2026-08-01T00:00:00Z'),
        ...overrides,
    };
}

function prepareReconciliation() {
    prismaMock.billingAccount.upsert.mockResolvedValue(freeAccount());
    prismaMock.adminMembership.findUnique.mockResolvedValue(null);
    prismaMock.planGrant.findMany.mockResolvedValue([
        { id: 'grant-1', plan: 'PRO' },
    ]);
    prismaMock.billingAccount.update.mockResolvedValue(
        freeAccount({
            plan: 'PRO',
            planSource: 'COMPLIMENTARY',
            serverCreditsBalance: 5_000,
            monthlyServerCreditsLimit: 5_000,
        })
    );
}

describe('premium invitation acceptance', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.unstubAllEnvs();
        vi.stubEnv('PREMIUM_INVITATION_TOKEN_SECRET', 'test-secret-at-least-32-characters-long');
        vi.stubEnv('BACKRANQ_EMAIL_FROM', 'Backranq <hello@example.com>');
        renderMock.mockResolvedValue('<p>Invitation</p>');
        sendEmailMock.mockResolvedValue('smtp-message-1');
    });

    it('rejects acceptance from a different signed-in email', async () => {
        const premium = await importInvitations();
        prismaMock.user.findUnique.mockResolvedValue({
            id: 'user-1',
            email: 'other@example.com',
        });
        prismaMock.premiumInvitation.findUnique.mockResolvedValue(invitation());

        await expect(
            premium.acceptPremiumInvitation({
                token: 'raw-token',
                userId: 'user-1',
                now: new Date('2026-08-06T00:00:00Z'),
            })
        ).rejects.toThrow('different email address');
        expect(prismaMock.planGrant.upsert).not.toHaveBeenCalled();
    });

    it.each([
        ['expired', { expiresAt: new Date('2026-08-05T00:00:00Z') }],
        ['revoked', { revokedAt: new Date('2026-08-05T00:00:00Z') }],
    ])('rejects an %s invitation', async (_label, invitationState) => {
        const premium = await importInvitations();
        prismaMock.user.findUnique.mockResolvedValue({
            id: 'user-1',
            email: 'friend@example.com',
        });
        prismaMock.premiumInvitation.findUnique.mockResolvedValue(
            invitation(invitationState)
        );

        await expect(
            premium.acceptPremiumInvitation({
                token: 'raw-token',
                userId: 'user-1',
                now: new Date('2026-08-06T00:00:00Z'),
            })
        ).rejects.toThrow('expired or was revoked');
        expect(prismaMock.planGrant.upsert).not.toHaveBeenCalled();
    });

    it('accepts once, creates the grant, and immediately reconciles Pro', async () => {
        const premium = await importInvitations();
        prismaMock.user.findUnique.mockResolvedValue({
            id: 'user-1',
            email: 'friend@example.com',
        });
        prismaMock.premiumInvitation.findUnique.mockResolvedValue(invitation());
        prismaMock.planGrant.upsert.mockResolvedValue({ id: 'grant-1' });
        prismaMock.premiumInvitation.updateMany.mockResolvedValue({ count: 1 });
        prepareReconciliation();

        const account = await premium.acceptPremiumInvitation({
            token: 'raw-token',
            userId: 'user-1',
            now: new Date('2026-08-06T00:00:00Z'),
        });

        expect(prismaMock.planGrant.upsert).toHaveBeenCalledWith({
            where: {
                invitationId: '11111111-1111-4111-8111-111111111111',
            },
            update: {},
            create: expect.objectContaining({
                userId: 'user-1',
                plan: 'PRO',
                source: 'ADMIN_INVITATION',
            }),
        });
        expect(prismaMock.premiumInvitation.updateMany).toHaveBeenCalledWith({
            where: expect.objectContaining({
                id: '11111111-1111-4111-8111-111111111111',
                acceptedAt: null,
            }),
            data: expect.objectContaining({
                activeKey: null,
                acceptedById: 'user-1',
            }),
        });
        expect(account.plan).toBe('PRO');
        expect(scheduleWakeupMock).toHaveBeenCalledWith('user-1', 'billing');
    });

    it('treats a second accept by the same account as an idempotent replay', async () => {
        const premium = await importInvitations();
        prismaMock.user.findUnique.mockResolvedValue({
            id: 'user-1',
            email: 'friend@example.com',
        });
        prismaMock.premiumInvitation.findUnique.mockResolvedValue(
            invitation({
                activeKey: null,
                acceptedById: 'user-1',
                acceptedAt: new Date('2026-08-06T00:00:00Z'),
            })
        );
        prepareReconciliation();

        await premium.acceptPremiumInvitation({
            token: 'raw-token',
            userId: 'user-1',
            now: new Date('2026-08-06T01:00:00Z'),
        });

        expect(prismaMock.planGrant.upsert).not.toHaveBeenCalled();
        expect(prismaMock.premiumInvitation.updateMany).not.toHaveBeenCalled();
    });

    it('retries a serializable acceptance write conflict with bounded attempts', async () => {
        const premium = await importInvitations();
        const callbackImplementation = async (callback: unknown) =>
            (callback as (tx: typeof prismaMock) => Promise<unknown>)(
                prismaMock
            );
        prismaMock.$transaction
            .mockRejectedValueOnce(Object.assign(new Error('conflict'), { code: 'P2034' }))
            .mockImplementation(callbackImplementation);
        prismaMock.user.findUnique.mockResolvedValue({
            id: 'user-1',
            email: 'friend@example.com',
        });
        prismaMock.premiumInvitation.findUnique.mockResolvedValue(invitation());
        prismaMock.planGrant.upsert.mockResolvedValue({ id: 'grant-1' });
        prismaMock.premiumInvitation.updateMany.mockResolvedValue({ count: 1 });
        prepareReconciliation();

        await premium.acceptPremiumInvitation({
            token: 'raw-token',
            userId: 'user-1',
            now: new Date('2026-08-06T00:00:00Z'),
        });

        expect(prismaMock.$transaction).toHaveBeenCalledTimes(2);
    });
});

describe('premium invitation delivery generations', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.unstubAllEnvs();
        vi.stubEnv('PREMIUM_INVITATION_TOKEN_SECRET', 'test-secret-at-least-32-characters-long');
        vi.stubEnv('BACKRANQ_EMAIL_FROM', 'Backranq <hello@example.com>');
        renderMock.mockResolvedValue('<p>Invitation</p>');
        sendEmailMock.mockResolvedValue('smtp-message-1');
    });

    it('stores only a token hash and sends a deterministic generation token', async () => {
        const premium = await importInvitations();
        const record = invitation({
            deliveryLeaseToken: expect.any(String),
        });
        prismaMock.premiumInvitation.updateMany
            .mockResolvedValueOnce({ count: 1 })
            .mockResolvedValueOnce({ count: 1 });
        prismaMock.premiumInvitation.findUnique.mockImplementation(
            async () => ({
                ...record,
                deliveryLeaseToken: (
                    prismaMock.premiumInvitation.updateMany.mock.calls[0]?.[0] as {
                        data: { deliveryLeaseToken: string };
                    }
                ).data.deliveryLeaseToken,
            })
        );

        const result = await premium.deliverPremiumInvitationGeneration({
            invitationId: record.id,
            generation: 1,
            now: new Date('2026-08-06T00:00:00Z'),
        });

        const token = premium.premiumInvitationToken(record.id, 1);
        const sent = sendEmailMock.mock.calls[0]?.[0] as { text: string };
        expect(sent.text).toContain(encodeURIComponent(token));
        expect(sent.text).not.toContain(premium.premiumInvitationTokenHash(token));
        expect(result.status).toBe('SENT');
        expect(prismaMock.premiumInvitation.updateMany).toHaveBeenLastCalledWith({
            where: expect.objectContaining({
                deliveryGeneration: 1,
                deliveryStatus: 'SENDING',
                deliveryLeaseToken: expect.any(String),
            }),
            data: expect.objectContaining({
                deliveryStatus: 'SENT',
                providerEmailId: 'smtp-message-1',
            }),
        });
    });

    it('marks an ambiguous provider response without rotating the valid token', async () => {
        const premium = await importInvitations();
        sendEmailMock.mockRejectedValue(
            new AmbiguousSendError('delivery state is unknown')
        );
        prismaMock.premiumInvitation.updateMany
            .mockResolvedValueOnce({ count: 1 })
            .mockResolvedValueOnce({ count: 1 });
        prismaMock.premiumInvitation.findUnique.mockImplementation(async () => ({
            ...invitation(),
            deliveryLeaseToken: (
                prismaMock.premiumInvitation.updateMany.mock.calls[0]?.[0] as {
                    data: { deliveryLeaseToken: string };
                }
            ).data.deliveryLeaseToken,
        }));

        const result = await premium.deliverPremiumInvitationGeneration({
            invitationId: '11111111-1111-4111-8111-111111111111',
            generation: 1,
            now: new Date('2026-08-06T00:00:00Z'),
        });

        expect(result).toMatchObject({
            generation: 1,
            status: 'AMBIGUOUS',
            attempted: true,
        });
        expect(prismaMock.premiumInvitation.updateMany).toHaveBeenLastCalledWith({
            where: expect.any(Object),
            data: expect.objectContaining({
                deliveryStatus: 'AMBIGUOUS',
                deliveryLeaseToken: null,
            }),
        });
    });

    it('never sends or overwrites state when a newer generation already exists', async () => {
        const premium = await importInvitations();
        prismaMock.premiumInvitation.updateMany.mockResolvedValue({ count: 0 });
        prismaMock.premiumInvitation.findUnique.mockResolvedValue(
            invitation({
                deliveryGeneration: 2,
                deliveryStatus: 'SENT',
            })
        );

        const result = await premium.deliverPremiumInvitationGeneration({
            invitationId: '11111111-1111-4111-8111-111111111111',
            generation: 1,
            now: new Date('2026-08-06T00:00:00Z'),
        });

        expect(result).toMatchObject({
            generation: 2,
            status: 'SENT',
            attempted: false,
        });
        expect(sendEmailMock).not.toHaveBeenCalled();
        expect(prismaMock.premiumInvitation.updateMany).toHaveBeenCalledOnce();
    });
});
