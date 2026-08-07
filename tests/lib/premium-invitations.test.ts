import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockPrismaModule, prismaMock } from '../helpers/route-mocks';

const sendEmailMock = vi.fn();
const renderMock = vi.fn();
const scheduleWakeupMock = vi.fn();

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
        id: 'invite-1',
        email: 'Friend@Example.com',
        emailNormalized: 'friend@example.com',
        activeKey: 'friend@example.com',
        tokenHash: 'stored-hash',
        plan: 'PRO',
        invitedById: 'admin-1',
        acceptedById: null,
        expiresAt: new Date('2026-08-20T00:00:00Z'),
        acceptedAt: null,
        revokedAt: null,
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

describe('premium invitations', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.unstubAllEnvs();
        vi.stubEnv('BACKRANQ_EMAIL_FROM', 'Backranq <hello@example.com>');
        renderMock.mockResolvedValue('<p>Invitation</p>');
        sendEmailMock.mockResolvedValue('smtp-message-1');
    });

    it('normalizes addresses and stores only a hash of the emailed token', async () => {
        const premium = await importInvitations();
        prismaMock.user.findFirst.mockResolvedValue(null);
        prismaMock.premiumInvitation.upsert.mockResolvedValue(invitation());
        prismaMock.premiumInvitation.update.mockResolvedValue(
            invitation({ emailSentAt: new Date() })
        );

        await premium.createAndSendPremiumInvitation({
            invitedById: 'admin-1',
            adminMembershipId: 'membership-1',
            auditAction: 'PREMIUM_INVITATION_CREATE',
            email: ' Friend@Example.com ',
            now: new Date('2026-08-06T00:00:00Z'),
        });

        const upsert = prismaMock.premiumInvitation.upsert.mock.calls[0]?.[0] as {
            create: { tokenHash: string; emailNormalized: string };
        };
        expect(upsert.create.emailNormalized).toBe('friend@example.com');
        expect(upsert.create.tokenHash).toMatch(/^[a-f0-9]{64}$/);
        const sent = sendEmailMock.mock.calls[0]?.[0] as { text: string };
        expect(sent.text).toContain('https://backranq.example/invite/');
        expect(sent.text).not.toContain(upsert.create.tokenHash);
        expect(prismaMock.adminAuditLog.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                adminMembershipId: 'membership-1',
                action: 'PREMIUM_INVITATION_CREATE',
                targetId: 'invite-1',
            }),
        });
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

    it('accepts once, creates the grant, and immediately reconciles Pro', async () => {
        const premium = await importInvitations();
        prismaMock.user.findUnique.mockResolvedValue({
            id: 'user-1',
            email: 'friend@example.com',
        });
        prismaMock.premiumInvitation.findUnique.mockResolvedValue(invitation());
        prismaMock.planGrant.upsert.mockResolvedValue({ id: 'grant-1' });
        prismaMock.premiumInvitation.update.mockResolvedValue(
            invitation({
                activeKey: null,
                acceptedAt: new Date('2026-08-06T00:00:00Z'),
                acceptedById: 'user-1',
            })
        );
        prismaMock.billingAccount.upsert.mockResolvedValue(freeAccount());
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

        const account = await premium.acceptPremiumInvitation({
            token: 'raw-token',
            userId: 'user-1',
            now: new Date('2026-08-06T00:00:00Z'),
        });

        expect(prismaMock.planGrant.upsert).toHaveBeenCalledWith({
            where: { invitationId: 'invite-1' },
            update: {},
            create: expect.objectContaining({
                userId: 'user-1',
                plan: 'PRO',
                source: 'ADMIN_INVITATION',
                invitationId: 'invite-1',
            }),
        });
        expect(prismaMock.premiumInvitation.update).toHaveBeenCalledWith({
            where: { id: 'invite-1' },
            data: expect.objectContaining({
                activeKey: null,
                acceptedById: 'user-1',
            }),
        });
        expect(prismaMock.billingAccount.update).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    plan: 'PRO',
                    planSource: 'COMPLIMENTARY',
                    monthlyServerCreditsLimit: 5_000,
                }),
            })
        );
        expect(account.plan).toBe('PRO');
        expect(scheduleWakeupMock).toHaveBeenCalledWith('user-1', 'billing');
    });
});
