import { describe, expect, it, vi } from 'vitest';
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
