import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mockPrismaModule, prismaMock } from '../helpers/route-mocks';

const publishMock = vi.fn();
const recordPracticeDueMock = vi.fn();

function sqlText(query: unknown) {
    return ((query as { strings?: readonly string[] }).strings ?? []).join('');
}

async function importSweep() {
    vi.resetModules();
    mockPrismaModule();
    vi.doMock('@/lib/queues/backranq', () => ({
        publishBackranqQueueMessage: publishMock,
    }));
    vi.doMock('@/lib/notifications/service', () => ({
        recordPracticeDue: recordPracticeDueMock,
    }));
    return import('@/lib/training/practiceDueSweep');
}

describe('durable practice due sweep', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.unstubAllEnvs();
        publishMock.mockResolvedValue({ queued: true, messageId: 'queued-1' });
        recordPracticeDueMock.mockResolvedValue({ id: 'notification-1' });
        prismaMock.$transaction.mockImplementation(
            async (...args: unknown[]) =>
                (args[0] as (tx: typeof prismaMock) => unknown)(prismaMock)
        );
    });

    it('reaches a valid due row behind more than one thousand stale rows using only 256-row work items', async () => {
        const sweep = {
            id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            referenceAt: new Date('2026-08-07T00:00:00.000Z'),
            status: 'SCANNING' as 'SCANNING' | 'NOTIFYING' | 'COMPLETE',
            cursorNextDueAt: null as Date | null,
            cursorStateId: null as string | null,
        };
        let rawPage = 0;
        const rawQueries: string[] = [];
        prismaMock.$queryRaw.mockImplementation(async (query: unknown) => {
            const text = sqlText(query);
            if (text.includes('FOR UPDATE') && !text.includes('rawDue')) {
                return [{ ...sweep }];
            }
            rawQueries.push(text);
            rawPage += 1;
            const size = rawPage <= 4 ? 256 : 1;
            return Array.from({ length: size }, (_, index) => {
                const serial = (rawPage - 1) * 256 + index + 1;
                return {
                    stateId: `30000000-0000-4000-8000-${String(serial).padStart(12, '0')}`,
                    nextDueAt: new Date(
                        Date.UTC(2026, 0, 1, 0, 0, serial)
                    ),
                    userId:
                        rawPage === 5
                            ? '40000000-0000-4000-8000-000000000001'
                            : null,
                };
            });
        });
        prismaMock.practiceDueSweep.update.mockImplementation(
            async (...args: unknown[]) => {
                const { data } = args[0] as {
                    data: Record<string, unknown>;
                };
                if (data.status === 'NOTIFYING') sweep.status = 'NOTIFYING';
                sweep.cursorNextDueAt = data.cursorNextDueAt as Date;
                sweep.cursorStateId = data.cursorStateId as string;
                return { ...sweep };
            }
        );
        const { advancePracticeDueSweep } = await importSweep();

        for (let page = 0; page < 5; page += 1) {
            await advancePracticeDueSweep(sweep.id);
        }

        expect(rawQueries).toHaveLength(5);
        for (const query of rawQueries) {
            expect(query).toContain('WITH "rawDue" AS MATERIALIZED');
            expect(query.indexOf('LIMIT')).toBeLessThan(
                query.indexOf('LEFT JOIN LATERAL')
            );
            expect(query).toContain(
                `solution."acceptanceFrontier"->>'status' = 'STABLE'`
            );
        }
        expect(prismaMock.$executeRaw).toHaveBeenCalledTimes(1);
        expect(sweep.status).toBe('NOTIFYING');
        expect(sweep.cursorStateId).toBe(
            '30000000-0000-4000-8000-000000001025'
        );
    });

    it('publishes a continuation after exactly 50 users and finishes the next page', async () => {
        prismaMock.practiceDueSweep.findUniqueOrThrow.mockResolvedValue({
            status: 'NOTIFYING',
            referenceAt: new Date('2026-08-07T00:00:00.000Z'),
        });
        const summaries = Array.from({ length: 51 }, (_, index) => ({
            userId: `40000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
            dueCount: index === 0 ? 100 : 1,
            dueCountIsExact: index !== 0,
            earliestDueAt: new Date('2026-08-01T00:00:00.000Z'),
        }));
        prismaMock.practiceDueSweepUser.findMany
            .mockResolvedValueOnce(summaries.slice(0, 50))
            .mockResolvedValueOnce(summaries.slice(50));
        prismaMock.practiceDueSweep.updateMany.mockResolvedValue({ count: 1 });
        const { processPracticeDueNotificationPage } = await importSweep();

        const first = await processPracticeDueNotificationPage('sweep-1');
        const second = await processPracticeDueNotificationPage(
            'sweep-1',
            first.nextCursor!
        );

        expect(first.processed).toBe(50);
        expect(second.processed).toBe(1);
        expect(recordPracticeDueMock).toHaveBeenCalledTimes(51);
        expect(recordPracticeDueMock).toHaveBeenCalledWith(
            expect.objectContaining({ dueCount: 100, dueCountIsExact: false })
        );
        expect(publishMock).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'practice-due-notify',
                afterUserId: summaries[49]!.userId,
            }),
            expect.any(Object)
        );
        expect(prismaMock.practiceDueSweep.updateMany).toHaveBeenCalledWith({
            where: { id: 'sweep-1', status: 'NOTIFYING' },
            data: { status: 'COMPLETE', completedAt: expect.any(Date) },
        });
    });

    it('deletes only one indexed page of old completed sweeps', async () => {
        prismaMock.$queryRaw.mockResolvedValue(
            Array.from({ length: 25 }, (_, index) => ({ id: `sweep-${index}` }))
        );
        const { cleanupCompletedPracticeDueSweeps } = await importSweep();

        await expect(
            cleanupCompletedPracticeDueSweeps(
                new Date('2026-08-07T00:00:00.000Z')
            )
        ).resolves.toEqual({
            deleted: 25,
            hasMore: true,
            lastDeletedId: 'sweep-24',
        });
        const query = sqlText(prismaMock.$queryRaw.mock.calls[0]![0]);
        expect(query).toContain('"status" = \'COMPLETE\'');
        expect(query).toContain('"completedAt" <');
        expect(query).toContain('LIMIT');
        expect(query).toContain('FOR UPDATE SKIP LOCKED');
        expect(query).not.toContain("'SCANNING'");
        expect(query).not.toContain("'NOTIFYING'");
    });

    it('resumes the single active sweep instead of accumulating abandoned snapshots', async () => {
        prismaMock.practiceDueSweep.findFirst.mockResolvedValue({
            id: 'active-sweep',
            status: 'SCANNING',
        });
        const { schedulePracticeDueSweep } = await importSweep();

        await expect(
            schedulePracticeDueSweep(
                new Date('2026-08-07T12:00:00.000Z')
            )
        ).resolves.toEqual({
            sweepId: 'active-sweep',
            status: 'SCANNING',
            queued: true,
        });
        expect(prismaMock.practiceDueSweep.upsert).not.toHaveBeenCalled();
        expect(publishMock).toHaveBeenCalledWith(
            { type: 'practice-due-sweep', sweepId: 'active-sweep' },
            {
                idempotencyKey:
                    'practice-due-sweep:active-sweep:resume:2026-08-07',
            }
        );
    });
});
