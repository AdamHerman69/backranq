import { NextResponse } from 'next/server';

import { boundedJsonBody } from '@/lib/api/validation';
import {
    ADMIN_MUTATION_MAX_BYTES,
    isAdminApiResponse,
    requireAdminMutation,
} from '@/lib/admin/http';
import {
    executePremiumAdminCommand,
    PremiumAdminCommandConflict,
} from '@/lib/premium/adminCommandService';
import { parsePremiumAdminCommand } from '@/lib/premium/adminContracts';
import { PremiumInvitationError } from '@/lib/premium/invitations';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(request: Request) {
    const context = await requireAdminMutation(request, 'PREMIUM_MANAGE');
    if (isAdminApiResponse(context)) return context;

    const body = await boundedJsonBody(request, ADMIN_MUTATION_MAX_BYTES);
    if (!body.ok) {
        return NextResponse.json(
            { error: body.error, code: 'INVALID_PREMIUM_COMMAND' },
            { status: body.status ?? 400 }
        );
    }
    const parsed = parsePremiumAdminCommand(body.value);
    if (!parsed.ok) {
        return NextResponse.json(
            { error: parsed.error, code: 'INVALID_PREMIUM_COMMAND' },
            { status: 400 }
        );
    }

    try {
        const receipt = await executePremiumAdminCommand({
            context,
            command: parsed.value,
        });
        return NextResponse.json(receipt, {
            status: receipt.replayed ? 200 : 202,
            headers: { 'Cache-Control': 'private, no-store' },
        });
    } catch (error) {
        if (error instanceof PremiumAdminCommandConflict) {
            return NextResponse.json(
                { error: error.message, code: 'PREMIUM_COMMAND_CONFLICT' },
                { status: 409 }
            );
        }
        if (error instanceof PremiumInvitationError) {
            return NextResponse.json(
                { error: error.message, code: 'PREMIUM_COMMAND_INVALID' },
                { status: 400 }
            );
        }
        throw error;
    }
}
