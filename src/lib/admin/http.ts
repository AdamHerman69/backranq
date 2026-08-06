import { createHmac } from 'node:crypto';
import { NextResponse } from 'next/server';

import {
    ADMIN_IDEMPOTENCY_HEADER,
    ADMIN_REQUEST_HEADER,
} from '@/lib/admin/contracts';
import {
    AdminAccessError,
    requireAdminSession,
    type AdminCapability,
    type AdminPrincipal,
} from '@/lib/auth/admin';

export const ADMIN_MUTATION_MAX_BYTES = 32_000;
export { ADMIN_IDEMPOTENCY_HEADER, ADMIN_REQUEST_HEADER };

const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;

export type AdminMutationContext = {
    principal: AdminPrincipal;
    idempotencyKey: string;
    requestId: string;
    ipHash: string | null;
    userAgentHash: string | null;
};

export async function requireAdminApi(
    capability: AdminCapability
): Promise<AdminPrincipal | NextResponse> {
    try {
        return await requireAdminSession(capability);
    } catch (error) {
        if (error instanceof AdminAccessError) {
            return NextResponse.json(
                { error: error.message, code: error.code },
                { status: error.status }
            );
        }
        throw error;
    }
}

function trustedRequestOrigin(request: Request): boolean {
    const requestUrl = new URL(request.url);
    const origin = request.headers.get('origin');
    if (!origin) return false;

    try {
        return new URL(origin).origin === requestUrl.origin;
    } catch {
        return false;
    }
}

function hashRequestValue(value: string | null): string | null {
    if (!value) return null;
    const secret =
        process.env.BACKRANQ_ADMIN_AUDIT_SECRET ??
        process.env.AUTH_SECRET ??
        process.env.NEXTAUTH_SECRET;
    if (!secret) return null;
    return createHmac('sha256', secret).update(value).digest('hex');
}

export async function requireAdminMutation(
    request: Request,
    capability: AdminCapability
): Promise<AdminMutationContext | NextResponse> {
    const principal = await requireAdminApi(capability);
    if (principal instanceof NextResponse) return principal;

    if (
        !trustedRequestOrigin(request) ||
        request.headers.get(ADMIN_REQUEST_HEADER) !== '1'
    ) {
        return NextResponse.json(
            { error: 'Untrusted admin request', code: 'ADMIN_CSRF_REJECTED' },
            { status: 403 }
        );
    }

    const contentType = request.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().startsWith('application/json')) {
        return NextResponse.json(
            { error: 'Expected application/json', code: 'INVALID_CONTENT_TYPE' },
            { status: 415 }
        );
    }

    const idempotencyKey = request.headers
        .get(ADMIN_IDEMPOTENCY_HEADER)
        ?.trim();
    if (!idempotencyKey || !IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
        return NextResponse.json(
            {
                error: 'A valid idempotency key is required',
                code: 'INVALID_IDEMPOTENCY_KEY',
            },
            { status: 400 }
        );
    }

    return {
        principal,
        idempotencyKey: `${principal.membershipId}:${idempotencyKey}`,
        requestId:
            request.headers.get('x-vercel-id') ?? crypto.randomUUID(),
        ipHash: hashRequestValue(
            request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
                null
        ),
        userAgentHash: hashRequestValue(request.headers.get('user-agent')),
    };
}

export function isAdminApiResponse(
    value: AdminPrincipal | AdminMutationContext | NextResponse
): value is NextResponse {
    return value instanceof NextResponse;
}
