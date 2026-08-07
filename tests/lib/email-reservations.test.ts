import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mockPrismaModule, prismaMock } from '../helpers/route-mocks';

const sendSmtp2GoEmailMock = vi.fn();

async function importReservations() {
    vi.resetModules();
    mockPrismaModule();
    vi.doMock('@/lib/notifications/smtp2go', async (importOriginal) => {
        const actual = await importOriginal<
            typeof import('@/lib/notifications/smtp2go')
        >();
        return { ...actual, sendSmtp2GoEmail: sendSmtp2GoEmailMock };
    });
    return import('@/lib/notifications/emailReservations');
}

function email() {
    return {
        from: 'Backranq <notifications@example.com>',
        to: 'player@example.com',
        subject: 'Ready',
        html: '<p>Ready</p>',
        text: 'Ready',
    };
}

describe('shared email provider reservations', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.unstubAllEnvs();
        vi.stubEnv('SMTP2GO_DAILY_SEND_LIMIT', '30');
        vi.stubEnv('SMTP2GO_TRANSACTIONAL_RESERVE', '5');
        prismaMock.$transaction.mockImplementation(
            async (callback: unknown) =>
                (callback as (tx: typeof prismaMock) => Promise<unknown>)(
                    prismaMock
                )
        );
        prismaMock.emailProviderDay.upsert.mockResolvedValue({});
        prismaMock.emailProviderDay.updateMany.mockResolvedValue({ count: 1 });
        prismaMock.$queryRaw.mockResolvedValue([]);
        prismaMock.emailSendReservation.create.mockImplementation(
            async (...args: unknown[]) => {
                const input = args[0] as {
                    data: { ownerToken: string };
                };
                return {
                    id: `reservation-${input.data.ownerToken}`,
                    ownerToken: input.data.ownerToken,
                };
            }
        );
        prismaMock.emailSendReservation.updateMany.mockResolvedValue({
            count: 1,
        });
        sendSmtp2GoEmailMock.mockResolvedValue('smtp-message-1');
    });

    it('atomically reserves non-priority budget and fences provider state by owner token', async () => {
        const { sendReservedSmtp2GoEmail } = await importReservations();

        await expect(
            sendReservedSmtp2GoEmail({
                ownerType: 'NOTIFICATION_DELIVERY',
                ownerId: '11111111-1111-4111-8111-111111111111',
                ownerToken: '22222222-2222-4222-8222-222222222222',
                priority: false,
                practiceWindowKey: 'practice:user-1:2026-08-07',
                email: email(),
                now: new Date('2026-08-07T10:00:00.000Z'),
            })
        ).resolves.toBe('smtp-message-1');

        expect(prismaMock.emailProviderDay.updateMany).toHaveBeenCalledWith({
            where: {
                day: new Date('2026-08-07T00:00:00.000Z'),
                reservedCount: { lt: 30 },
                nonPriorityReservedCount: { lt: 25 },
            },
            data: {
                reservedCount: { increment: 1 },
                nonPriorityReservedCount: { increment: 1 },
            },
        });
        expect(prismaMock.emailSendReservation.updateMany).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                where: expect.objectContaining({
                    ownerToken: '22222222-2222-4222-8222-222222222222',
                    status: 'RESERVED',
                }),
                data: { status: 'HANDOFF' },
            })
        );
        expect(prismaMock.emailSendReservation.updateMany).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                where: expect.objectContaining({
                    ownerToken: '22222222-2222-4222-8222-222222222222',
                    status: 'HANDOFF',
                }),
                data: expect.objectContaining({ status: 'SENT' }),
            })
        );
    });

    it('allows only one concurrent owner of a Practice local-day window', async () => {
        let createCalls = 0;
        prismaMock.emailSendReservation.create.mockImplementation(
            async (...args: unknown[]) => {
                createCalls += 1;
                const input = args[0] as {
                    data: { ownerToken: string };
                };
                if (createCalls === 2) {
                    throw Object.assign(new Error('unique window'), {
                        code: 'P2002',
                        meta: { target: ['practiceWindowKey'] },
                    });
                }
                return {
                    id: 'reservation-winner',
                    ownerToken: input.data.ownerToken,
                };
            }
        );
        prismaMock.emailSendReservation.findUnique.mockResolvedValue({
            id: 'reservation-winner',
            ownerToken: '22222222-2222-4222-8222-222222222222',
            providerDay: new Date('2026-08-07T00:00:00.000Z'),
            priority: false,
            status: 'HANDOFF',
            leaseUntil: new Date('2026-08-07T10:15:00.000Z'),
        });
        const reservations = await importReservations();
        const common = {
            ownerType: 'NOTIFICATION_DELIVERY' as const,
            ownerId: '11111111-1111-4111-8111-111111111111',
            priority: false,
            practiceWindowKey: 'practice:user-1:2026-08-07',
            email: email(),
            now: new Date('2026-08-07T10:00:00.000Z'),
        };

        const results = await Promise.allSettled([
            reservations.sendReservedSmtp2GoEmail({
                ...common,
                ownerToken: '22222222-2222-4222-8222-222222222222',
            }),
            reservations.sendReservedSmtp2GoEmail({
                ...common,
                ownerToken: '33333333-3333-4333-8333-333333333333',
            }),
        ]);

        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        const rejected = results.find(
            (result): result is PromiseRejectedResult =>
                result.status === 'rejected'
        );
        expect(rejected?.reason).toBeInstanceOf(
            reservations.PracticeEmailWindowClaimedError
        );
        expect(sendSmtp2GoEmailMock).toHaveBeenCalledTimes(1);
    });

    it('does not misclassify an owner-token collision as a Practice window collision', async () => {
        prismaMock.emailSendReservation.create.mockRejectedValue(
            Object.assign(new Error('unique owner token'), {
                code: 'P2002',
                meta: { target: ['ownerToken'] },
            })
        );
        const reservations = await importReservations();

        await expect(
            reservations.sendReservedSmtp2GoEmail({
                ownerType: 'NOTIFICATION_DELIVERY',
                ownerId: '11111111-1111-4111-8111-111111111111',
                ownerToken: '22222222-2222-4222-8222-222222222222',
                priority: false,
                practiceWindowKey: 'practice:user-1:2026-08-07',
                email: email(),
                now: new Date('2026-08-07T10:00:00.000Z'),
            })
        ).rejects.toThrow('unique owner token');
    });

    it('reclaims only a bounded token-fenced slice of expired RESERVED claims', async () => {
        prismaMock.$queryRaw.mockResolvedValue([
            {
                id: '11111111-1111-4111-8111-111111111111',
                ownerToken: '22222222-2222-4222-8222-222222222222',
                providerDay: new Date('2026-08-07T00:00:00.000Z'),
                priority: false,
            },
        ]);
        const { releaseExpiredEmailReservations } =
            await importReservations();
        const now = new Date('2026-08-07T10:00:00.000Z');

        await expect(
            releaseExpiredEmailReservations(now)
        ).resolves.toBe(1);

        const query = prismaMock.$queryRaw.mock.calls[0]?.[0] as {
            strings: readonly string[];
        };
        const queryText = query.strings.join('');
        expect(queryText).toContain('LIMIT');
        expect(queryText).toContain('FOR UPDATE SKIP LOCKED');
        expect(prismaMock.emailSendReservation.updateMany).toHaveBeenCalledWith({
            where: {
                id: '11111111-1111-4111-8111-111111111111',
                ownerToken: '22222222-2222-4222-8222-222222222222',
                status: 'RESERVED',
                leaseUntil: { lte: now },
            },
            data: {
                status: 'RELEASED',
                practiceWindowKey: null,
                lastError: 'Reservation expired before provider handoff',
            },
        });
        expect(prismaMock.emailProviderDay.updateMany).toHaveBeenCalledWith({
            where: {
                day: new Date('2026-08-07T00:00:00.000Z'),
                reservedCount: { gte: 1 },
                nonPriorityReservedCount: { gte: 1 },
            },
            data: {
                reservedCount: { decrement: 1 },
                nonPriorityReservedCount: { decrement: 1 },
            },
        });
    });

    it('prevents Premium and notification sends from double-spending one shared slot', async () => {
        prismaMock.emailProviderDay.updateMany
            .mockResolvedValueOnce({ count: 1 })
            .mockResolvedValueOnce({ count: 0 });
        const reservations = await importReservations();

        const first = reservations.sendReservedSmtp2GoEmail({
            ownerType: 'PREMIUM_INVITATION',
            ownerId: '11111111-1111-4111-8111-111111111111',
            ownerToken: '22222222-2222-4222-8222-222222222222',
            priority: false,
            email: email(),
            now: new Date('2026-08-07T10:00:00.000Z'),
        });
        const second = reservations.sendReservedSmtp2GoEmail({
            ownerType: 'NOTIFICATION_DELIVERY',
            ownerId: '33333333-3333-4333-8333-333333333333',
            ownerToken: '44444444-4444-4444-8444-444444444444',
            priority: false,
            email: email(),
            now: new Date('2026-08-07T10:00:00.000Z'),
        });

        const results = await Promise.allSettled([first, second]);
        expect(results[0]).toEqual({
            status: 'fulfilled',
            value: 'smtp-message-1',
        });
        expect(
            results[1]?.status === 'rejected' ? results[1].reason : null
        ).toBeInstanceOf(
            reservations.EmailBudgetUnavailableError
        );
        expect(sendSmtp2GoEmailMock).toHaveBeenCalledTimes(1);
    });

    it('releases the budget and Practice window after a definite provider rejection', async () => {
        sendSmtp2GoEmailMock.mockRejectedValue(new Error('recipient rejected'));
        prismaMock.emailSendReservation.findUnique.mockResolvedValue({
            ownerToken: '22222222-2222-4222-8222-222222222222',
            providerDay: new Date('2026-08-07T00:00:00.000Z'),
            priority: false,
            status: 'HANDOFF',
        });
        const { sendReservedSmtp2GoEmail } = await importReservations();

        await expect(
            sendReservedSmtp2GoEmail({
                ownerType: 'NOTIFICATION_DELIVERY',
                ownerId: '11111111-1111-4111-8111-111111111111',
                ownerToken: '22222222-2222-4222-8222-222222222222',
                priority: false,
                practiceWindowKey: 'practice:user-1:2026-08-07',
                email: email(),
                now: new Date('2026-08-07T10:00:00.000Z'),
            })
        ).rejects.toThrow('recipient rejected');

        expect(prismaMock.emailSendReservation.updateMany).toHaveBeenLastCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    status: 'RELEASED',
                    practiceWindowKey: null,
                }),
            })
        );
        expect(prismaMock.emailProviderDay.updateMany).toHaveBeenLastCalledWith({
            where: {
                day: new Date('2026-08-07T00:00:00.000Z'),
                reservedCount: { gte: 1 },
                nonPriorityReservedCount: { gte: 1 },
            },
            data: {
                reservedCount: { decrement: 1 },
                nonPriorityReservedCount: { decrement: 1 },
            },
        });
    });

    it('keeps the handoff reserved when provider success cannot be persisted', async () => {
        prismaMock.emailSendReservation.updateMany
            .mockResolvedValueOnce({ count: 1 })
            .mockRejectedValueOnce(new Error('database unavailable'));
        const { sendReservedSmtp2GoEmail } = await importReservations();

        await expect(
            sendReservedSmtp2GoEmail({
                ownerType: 'NOTIFICATION_DELIVERY',
                ownerId: '11111111-1111-4111-8111-111111111111',
                ownerToken: '22222222-2222-4222-8222-222222222222',
                priority: false,
                practiceWindowKey: 'practice:user-1:2026-08-07',
                email: email(),
                now: new Date('2026-08-07T10:00:00.000Z'),
            })
        ).rejects.toThrow('must not be retried automatically');

        expect(sendSmtp2GoEmailMock).toHaveBeenCalledOnce();
        expect(prismaMock.emailSendReservation.updateMany).toHaveBeenCalledTimes(2);
        expect(prismaMock.emailProviderDay.updateMany).toHaveBeenCalledOnce();
    });
});
