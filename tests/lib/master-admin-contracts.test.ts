import { describe, expect, it } from 'vitest';

import { parseMasterAdminCommand } from '@/lib/master/adminContracts';

const now = new Date('2026-08-06T10:00:00.000Z');
const candidateId = '123e4567-e89b-42d3-a456-426614174000';

describe('Weekly Master admin command parser', () => {
    it('accepts a bounded, explicit candidate decision', () => {
        expect(
            parseMasterAdminCommand(
                {
                    type: 'EXCLUDE_CANDIDATE',
                    candidateId,
                    reason: 'Tactic is too visually noisy for onboarding',
                },
                now
            )
        ).toEqual({
            ok: true,
            value: {
                type: 'EXCLUDE_CANDIDATE',
                candidateId,
                reason: 'Tactic is too visually noisy for onboarding',
            },
        });
    });

    it('accepts only a concrete source game for targeted analysis', () => {
        expect(
            parseMasterAdminCommand(
                {
                    type: 'ANALYZE_SOURCE_GAME',
                    sourceGameId: candidateId,
                    reason: 'Recheck the strongest recent source game',
                },
                now
            )
        ).toEqual({
            ok: true,
            value: {
                type: 'ANALYZE_SOURCE_GAME',
                sourceGameId: candidateId,
                reason: 'Recheck the strongest recent source game',
            },
        });
    });

    it('rejects unknown commands, unknown fields, and invalid ids', () => {
        expect(
            parseMasterAdminCommand(
                { type: 'DELETE_ALL', reason: 'Nope' },
                now
            )
        ).toEqual({ ok: false, error: 'Unknown admin command' });
        expect(
            parseMasterAdminCommand(
                {
                    type: 'APPROVE_CANDIDATE',
                    candidateId,
                    reason: 'Manual approval',
                    bypassQualityGates: true,
                },
                now
            )
        ).toEqual({ ok: false, error: 'Unknown admin command field' });
        expect(
            parseMasterAdminCommand(
                {
                    type: 'APPROVE_CANDIDATE',
                    candidateId: '../../all',
                    reason: 'Manual selection',
                },
                now
            )
        ).toEqual({ ok: false, error: 'Invalid candidate id' });
    });

    it('requires expiring overrides and caps them at ninety days', () => {
        const base = {
            type: 'PAUSE_AUTOMATION',
            reason: 'Provider incident investigation',
        } as const;

        expect(
            parseMasterAdminCommand(
                { ...base, expiresAt: '2026-08-06T09:59:00.000Z' },
                now
            ).ok
        ).toBe(false);
        expect(
            parseMasterAdminCommand(
                { ...base, expiresAt: '2027-08-06T10:00:00.000Z' },
                now
            ).ok
        ).toBe(false);
        expect(
            parseMasterAdminCommand(
                { ...base, expiresAt: '2026-08-07T10:00:00.000Z' },
                now
            ).ok
        ).toBe(true);
    });
});
