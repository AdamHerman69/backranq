import { describe, expect, it } from 'vitest';

import { parseTrainingCompletionTime } from '@/lib/training/completionTime';
import { parseRecordTrainingAttemptRequest } from '@/lib/training/apiValidation';

const receivedAt = new Date('2026-09-05T12:00:00.000Z');

describe('practice completion event time', () => {
    it.each([
        undefined, null, '', 'yesterday', '2026-02-30T12:00:00.000Z',
        '2026-09-05T12:00:00+00:00', '0000-01-01T00:00:00.000Z',
        '2026-09-05T12:05:00.001Z',
    ])('rejects malformed or future completion time %s', (value) => {
        expect(parseTrainingCompletionTime(value, receivedAt)).toBeNull();
    });

    it('accepts delayed offline events without imposing a retention cutoff', () => {
        const completedAt = '2025-01-01T00:00:00.000Z';
        expect(parseTrainingCompletionTime(completedAt, receivedAt)).toEqual(new Date(completedAt));
        expect(parseTrainingCompletionTime('2026-09-05T12:05:00.000Z', receivedAt)).not.toBeNull();
    });

    it('requires completion time on the HTTP request contract', () => {
        const request = {
            kind: 'RECORD',
            clientAttemptId: '11111111-1111-4111-8111-111111111111',
            solutionRevisionId: '22222222-2222-4222-8222-222222222222',
            status: 'REVEALED',
            steps: [],
        };
        expect(parseRecordTrainingAttemptRequest(request, receivedAt)).toBeNull();
        const completedAt = '2026-09-01T12:00:00.000Z';
        expect(parseRecordTrainingAttemptRequest({ ...request, completedAt }, receivedAt))
            .toEqual({ ...request, completedAt });
    });
});
