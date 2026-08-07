import { beforeEach, describe, expect, it, vi } from 'vitest';

const { requireAdminSessionMock } = vi.hoisted(() => ({
    requireAdminSessionMock: vi.fn(),
}));

vi.mock('@/lib/auth/admin', () => ({
    requireAdminSession: requireAdminSessionMock,
    AdminAccessError: class AdminAccessError extends Error {},
}));

import {
    ADMIN_IDEMPOTENCY_HEADER,
    ADMIN_REQUEST_HEADER,
} from '@/lib/admin/contracts';
import { isAdminApiResponse, requireAdminMutation } from '@/lib/admin/http';

function request(headers: Record<string, string> = {}) {
    return new Request('https://backranq.test/api/admin/weekly-master/commands', {
        method: 'POST',
        headers: {
            origin: 'https://backranq.test',
            'content-type': 'application/json',
            [ADMIN_REQUEST_HEADER]: '1',
            [ADMIN_IDEMPOTENCY_HEADER]: 'admin-test-key-0001',
            ...headers,
        },
        body: '{}',
    });
}

describe('admin mutation request guard', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubEnv('NEXTAUTH_SECRET', 'test-audit-secret');
        requireAdminSessionMock.mockResolvedValue({
            membershipId: 'membership-1',
            userId: 'user-1',
            role: 'ADMIN',
            capabilities: [],
        });
    });

    it('rejects a cross-origin browser request before accepting a command', async () => {
        const result = await requireAdminMutation(
            request({ origin: 'https://attacker.test' }),
            'MASTER_EDIT'
        );

        expect(isAdminApiResponse(result)).toBe(true);
        if (!isAdminApiResponse(result)) throw new Error('Expected response');
        expect(result.status).toBe(403);
    });

    it('requires the custom browser header and a bounded idempotency key', async () => {
        const missingHeader = await requireAdminMutation(
            request({ [ADMIN_REQUEST_HEADER]: '0' }),
            'MASTER_EDIT'
        );
        const shortKey = await requireAdminMutation(
            request({ [ADMIN_IDEMPOTENCY_HEADER]: 'short' }),
            'MASTER_EDIT'
        );

        expect(isAdminApiResponse(missingHeader)).toBe(true);
        expect(isAdminApiResponse(shortKey)).toBe(true);
        if (!isAdminApiResponse(shortKey)) throw new Error('Expected response');
        expect(shortKey.status).toBe(400);
    });

    it('returns only hashed request metadata to the audit layer', async () => {
        const result = await requireAdminMutation(
            request({
                'x-forwarded-for': '203.0.113.20',
                'user-agent': 'Admin Browser',
            }),
            'MASTER_EDIT'
        );

        expect(isAdminApiResponse(result)).toBe(false);
        if (isAdminApiResponse(result)) throw new Error('Expected context');
        expect(result.idempotencyKey).toBe(
            'membership-1:admin-test-key-0001'
        );
        expect(result.ipHash).toMatch(/^[a-f0-9]{64}$/);
        expect(result.userAgentHash).toMatch(/^[a-f0-9]{64}$/);
        expect(JSON.stringify(result)).not.toContain('203.0.113.20');
        expect(JSON.stringify(result)).not.toContain('Admin Browser');
    });
});
