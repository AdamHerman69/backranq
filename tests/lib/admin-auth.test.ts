import { beforeEach, describe, expect, it, vi } from 'vitest';

const { authMock, membershipMock } = vi.hoisted(() => ({
    authMock: vi.fn(),
    membershipMock: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ auth: authMock }));
vi.mock('@/lib/prisma', () => ({
    prisma: {
        adminMembership: { findUnique: membershipMock },
    },
}));

import {
    AdminAccessError,
    getAdminPrincipal,
    requireAdminSession,
    roleHasCapability,
} from '@/lib/auth/admin';

describe('admin capability guard', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        authMock.mockResolvedValue({ user: { id: 'user-1' } });
        membershipMock.mockResolvedValue({
            id: 'membership-1',
            userId: 'user-1',
            role: 'EDITOR',
            active: true,
        });
    });

    it('fails closed for a signed-out request before querying membership', async () => {
        authMock.mockResolvedValue(null);

        await expect(requireAdminSession('MASTER_VIEW')).rejects.toMatchObject({
            status: 401,
            code: 'ADMIN_AUTH_REQUIRED',
        } satisfies Partial<AdminAccessError>);
        expect(membershipMock).not.toHaveBeenCalled();
    });

    it('does not trust an inactive or missing database membership', async () => {
        membershipMock.mockResolvedValue({
            id: 'membership-1',
            userId: 'user-1',
            role: 'ADMIN',
            active: false,
        });

        await expect(requireAdminSession('MASTER_VIEW')).rejects.toMatchObject({
            status: 403,
        });
        await expect(getAdminPrincipal()).resolves.toBeNull();
    });

    it('allows editorial work but keeps publishing and user access admin-only', async () => {
        const principal = await requireAdminSession('MASTER_APPROVE');

        expect(principal).toMatchObject({
            membershipId: 'membership-1',
            role: 'EDITOR',
        });
        expect(roleHasCapability('EDITOR', 'MASTER_RUN')).toBe(true);
        expect(roleHasCapability('EDITOR', 'MASTER_PUBLISH')).toBe(false);
        expect(roleHasCapability('EDITOR', 'USER_VIEW')).toBe(false);
        expect(roleHasCapability('EDITOR', 'PREMIUM_MANAGE')).toBe(false);
        expect(roleHasCapability('ADMIN', 'MASTER_PUBLISH')).toBe(true);
        expect(roleHasCapability('ADMIN', 'PREMIUM_MANAGE')).toBe(true);
    });
});
