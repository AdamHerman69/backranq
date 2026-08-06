import { cache } from 'react';

import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export const ADMIN_ROLES = ['EDITOR', 'ADMIN'] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

export const ADMIN_CAPABILITIES = [
    'MASTER_VIEW',
    'MASTER_EDIT',
    'MASTER_RUN',
    'MASTER_APPROVE',
    'MASTER_PUBLISH',
    'USER_VIEW',
    'OPS_VIEW',
    'OPS_MUTATE',
] as const;
export type AdminCapability = (typeof ADMIN_CAPABILITIES)[number];

const ROLE_CAPABILITIES: Record<AdminRole, readonly AdminCapability[]> = {
    EDITOR: [
        'MASTER_VIEW',
        'MASTER_EDIT',
        'MASTER_RUN',
        'MASTER_APPROVE',
        'OPS_VIEW',
    ],
    ADMIN: ADMIN_CAPABILITIES,
};

export type AdminPrincipal = {
    membershipId: string;
    userId: string;
    role: AdminRole;
    capabilities: readonly AdminCapability[];
};

export class AdminAccessError extends Error {
    readonly status: 401 | 403;
    readonly code: 'ADMIN_AUTH_REQUIRED' | 'ADMIN_FORBIDDEN';

    constructor(status: 401 | 403) {
        super(status === 401 ? 'Authentication required' : 'Forbidden');
        this.name = 'AdminAccessError';
        this.status = status;
        this.code =
            status === 401 ? 'ADMIN_AUTH_REQUIRED' : 'ADMIN_FORBIDDEN';
    }
}

function isAdminRole(value: unknown): value is AdminRole {
    return (
        typeof value === 'string' &&
        (ADMIN_ROLES as readonly string[]).includes(value)
    );
}

export function roleHasCapability(
    role: AdminRole,
    capability: AdminCapability
): boolean {
    return ROLE_CAPABILITIES[role].includes(capability);
}

/**
 * Returns the current, DB-backed admin identity. Session claims are deliberately
 * not authoritative so revocation takes effect on the next request.
 */
export const getAdminPrincipal = cache(async function getAdminPrincipal(): Promise<AdminPrincipal | null> {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return null;

    const membership = await prisma.adminMembership.findUnique({
        where: { userId },
        select: {
            id: true,
            userId: true,
            role: true,
            active: true,
        },
    });
    if (
        !membership ||
        !membership.active ||
        !isAdminRole(membership.role)
    ) {
        return null;
    }

    return {
        membershipId: membership.id,
        userId: membership.userId,
        role: membership.role,
        capabilities: ROLE_CAPABILITIES[membership.role],
    };
});

export async function requireAdminSession(
    capability: AdminCapability
): Promise<AdminPrincipal> {
    const principal = await getAdminPrincipal();
    if (!principal) {
        const session = await auth();
        throw new AdminAccessError(session?.user?.id ? 403 : 401);
    }
    if (!roleHasCapability(principal.role, capability)) {
        throw new AdminAccessError(403);
    }
    return principal;
}
