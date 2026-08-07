import { NextResponse } from 'next/server';

import { boundedJsonBody } from '@/lib/api/validation';
import {
    ADMIN_MUTATION_MAX_BYTES,
    isAdminApiResponse,
    requireAdminMutation,
} from '@/lib/admin/http';
import { roleHasCapability, type AdminCapability } from '@/lib/auth/admin';
import {
    parseMasterAdminCommand,
    type MasterAdminCommand,
} from '@/lib/master/adminContracts';
import {
    AdminCommandConflict,
    AdminCommandDispatchError,
    executeMasterAdminCommand,
} from '@/lib/master/adminCommandService';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function requiredCapability(command: MasterAdminCommand): AdminCapability {
    switch (command.type) {
        case 'FORCE_PIPELINE':
        case 'ANALYZE_SOURCE_GAME':
            return 'MASTER_RUN';
        case 'PIN_PUBLICATION':
        case 'SELECT_CANDIDATE':
        case 'FORCE_FALLBACK':
        case 'WITHDRAW_PUBLICATION':
            return 'MASTER_PUBLISH';
        case 'PAUSE_AUTOMATION':
        case 'REVOKE_OVERRIDE':
            return 'OPS_MUTATE';
        default:
            return 'MASTER_EDIT';
    }
}

export async function POST(request: Request) {
    const context = await requireAdminMutation(request, 'MASTER_EDIT');
    if (isAdminApiResponse(context)) return context;

    const parsedBody = await boundedJsonBody(
        request,
        ADMIN_MUTATION_MAX_BYTES
    );
    if (!parsedBody.ok) {
        return NextResponse.json(
            { error: parsedBody.error, code: 'INVALID_ADMIN_COMMAND' },
            { status: parsedBody.status ?? 400 }
        );
    }
    const parsed = parseMasterAdminCommand(parsedBody.value);
    if (!parsed.ok) {
        return NextResponse.json(
            { error: parsed.error, code: 'INVALID_ADMIN_COMMAND' },
            { status: 400 }
        );
    }

    const capability = requiredCapability(parsed.value);
    if (!roleHasCapability(context.principal.role, capability)) {
        return NextResponse.json(
            { error: 'Forbidden', code: 'ADMIN_FORBIDDEN' },
            { status: 403 }
        );
    }

    try {
        const receipt = await executeMasterAdminCommand({
            context,
            command: parsed.value,
        });
        return NextResponse.json(receipt, {
            status: receipt.replayed ? 200 : 202,
            headers: { 'Cache-Control': 'private, no-store' },
        });
    } catch (error) {
        if (error instanceof AdminCommandConflict) {
            return NextResponse.json(
                { error: error.message, code: 'ADMIN_COMMAND_CONFLICT' },
                { status: 409 }
            );
        }
        if (error instanceof AdminCommandDispatchError) {
            return NextResponse.json(
                {
                    error: error.message,
                    code: 'ADMIN_COMMAND_DISPATCH_FAILED',
                    retryable: true,
                },
                { status: 503 }
            );
        }
        throw error;
    }
}
