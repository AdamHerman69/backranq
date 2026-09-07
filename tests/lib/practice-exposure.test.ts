import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import {
    parsePracticeExposureWrite,
    recordPracticeExposure,
} from '@/lib/training/exposure';

const now = new Date('2026-07-30T12:00:00.000Z');
const common = {
    clientExposureId:
        '10000000-0000-4000-8000-000000000001',
    clientEventId: '10000000-0000-4000-8000-000000000002',
    momentId: '10000000-0000-4000-8000-000000000003',
    solutionRevisionId:
        '10000000-0000-4000-8000-000000000004',
    shownAt: '2026-07-30T11:59:00.000Z',
    occurredAt: '2026-07-30T11:59:00.000Z',
    entry: 'progress' as const,
    recommendationKey: 'review-position' as const,
    focus: 'MEANINGFUL' as const,
};

describe('Practice exposure evidence', () => {
    it.each([
        'PracticeExposure_userId_fkey',
        'PracticeExposure_trainingMomentId_userId_fkey',
        'PracticeExposure_solutionRevision_moment_fkey',
        'PracticeExposure_attemptId_userId_fkey',
    ])('returns not found when a checked parent is deleted before insert: %s', async (constraint) => {
        const create = vi.fn().mockRejectedValue(new Prisma.PrismaClientKnownRequestError('Parent deleted', {
            code: 'P2003', clientVersion: '6.19.3',
            meta: { modelName: 'PracticeExposure', constraint },
        }));
        const result = await recordPracticeExposure({
            db: {
                trainingMoment: { findFirst: vi.fn().mockResolvedValue({ id: common.momentId }) },
                trainingAttempt: { findFirst: vi.fn().mockResolvedValue({ id: '10000000-0000-4000-8000-000000000005' }) },
                practiceExposure: { create },
            } as never,
            userId: 'user-1',
            event: { ...common, kind: 'TERMINAL', terminalReason: 'MOVE_SUBMITTED', attemptId: '10000000-0000-4000-8000-000000000005' },
        });
        expect(create).toHaveBeenCalledOnce();
        expect(result).toEqual({ ok: false, reason: 'NOT_FOUND' });
    });

    it.each([
        ['P2003', 'unrelated_fkey', 'PracticeExposure'],
        ['P2003', 'PracticeExposure_trainingMomentId_userId_fkey', 'OtherModel'],
        ['P2010', 'PracticeExposure_trainingMomentId_userId_fkey', 'PracticeExposure'],
    ])('does not hide unrelated database failures: %s / %s / %s', async (code, constraint, modelName) => {
        const error = new Prisma.PrismaClientKnownRequestError('Database failed', {
            code, clientVersion: '6.19.3', meta: { modelName, constraint },
        });
        await expect(recordPracticeExposure({
            db: {
                trainingMoment: { findFirst: vi.fn().mockResolvedValue({ id: common.momentId }) },
                trainingAttempt: { findFirst: vi.fn() },
                practiceExposure: { create: vi.fn().mockRejectedValue(error) },
            } as never,
            userId: 'user-1', event: { ...common, kind: 'SHOWN' },
        })).rejects.toBe(error);
    });

    it('accepts the single Progress entry contract and rejects arbitrary surfaces', () => {
        expect(
            parsePracticeExposureWrite(
                { ...common, kind: 'SHOWN' },
                now
            )
        ).not.toBeNull();
        expect(
            parsePracticeExposureWrite(
                {
                    ...common,
                    kind: 'SHOWN',
                    entry: 'games',
                },
                now
            )
        ).toBeNull();
    });

    it('requires an attempt only for move/reveal terminal reasons', () => {
        expect(
            parsePracticeExposureWrite(
                {
                    ...common,
                    kind: 'TERMINAL',
                    terminalReason: 'MOVE_SUBMITTED',
                },
                now
            )
        ).toBeNull();
        expect(
            parsePracticeExposureWrite(
                {
                    ...common,
                    kind: 'TERMINAL',
                    terminalReason: 'NAVIGATED_AWAY',
                    attemptId:
                        '10000000-0000-4000-8000-000000000005',
                },
                now
            )
        ).toBeNull();
    });

    it('maps entry=progress server-side and stores client/server time separately', async () => {
        const create = vi.fn().mockResolvedValue({ id: 'exposure-1' });
        const event = parsePracticeExposureWrite(
            { ...common, kind: 'SHOWN' },
            now
        );
        expect(event).not.toBeNull();

        const result = await recordPracticeExposure({
            db: {
                trainingMoment: {
                    findFirst: vi.fn().mockResolvedValue({
                        id: common.momentId,
                        currentSolutionRevisionId:
                            common.solutionRevisionId,
                    }),
                },
                trainingAttempt: {
                    findFirst: vi.fn(),
                },
                practiceExposure: { create },
            } as never,
            userId: 'user-1',
            event: event!,
        });

        expect(result).toEqual({ ok: true, duplicate: false });
        expect(create).toHaveBeenCalledWith({
            data: {
                userId: 'user-1',
                trainingMomentId: common.momentId,
                solutionRevisionId:
                    common.solutionRevisionId,
                attemptId: null,
                clientExposureId: common.clientExposureId,
                clientEventId: common.clientEventId,
                kind: 'SHOWN',
                shownAt: new Date(common.shownAt),
                clientOccurredAt: new Date(common.occurredAt),
                entrySurface: 'PROGRESS',
                recommendationKey: 'review-position',
                focus: 'MEANINGFUL',
                terminalReason: null,
            },
        });
    });
});
