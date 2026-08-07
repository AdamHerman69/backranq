'use client';

import { useState, useTransition, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

import type { ButtonProps } from '@/components/ui/button';
import { ActionConfirmDialog } from '@/components/ui/ActionConfirmDialog';
import { Input } from '@/components/ui/input';
import { LoadingButton } from '@/components/ui/loading-button';
import {
    ADMIN_IDEMPOTENCY_HEADER,
    ADMIN_REQUEST_HEADER,
} from '@/lib/admin/contracts';
import type {
    PremiumAdminCommand,
    PremiumAdminCommandReceipt,
} from '@/lib/premium/adminContracts';

type CommandResponse = PremiumAdminCommandReceipt & { error?: string };

export function PremiumInviteForm({ disabled }: { disabled: boolean }) {
    const router = useRouter();
    const [pending, startTransition] = useTransition();
    const [email, setEmail] = useState('');

    function submit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        startTransition(async () => {
            const receipt = await sendPremiumCommand({
                type: 'CREATE_INVITATION',
                email,
            });
            if (!receipt) return;
            showReceipt(receipt, 'Invitation command accepted');
            setEmail('');
            router.refresh();
        });
    }

    return (
        <form onSubmit={submit} className="flex flex-col gap-3 sm:flex-row">
            <Input
                type="email"
                name="email"
                required
                maxLength={254}
                autoComplete="email"
                placeholder="friend@example.com"
                aria-label="Invitation email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                disabled={disabled || pending}
            />
            <LoadingButton
                type="submit"
                className="w-full sm:w-auto"
                loading={pending}
                loadingLabel="Sending…"
                disabled={disabled}
            >
                Send invitation
            </LoadingButton>
        </form>
    );
}

export function PremiumCommandButton({
    command,
    confirmMessage,
    children,
    ...buttonProps
}: ButtonProps & {
    command: Exclude<PremiumAdminCommand, { type: 'CREATE_INVITATION' }>;
    confirmMessage?: string;
}) {
    const router = useRouter();
    const [pending, startTransition] = useTransition();
    const [confirmOpen, setConfirmOpen] = useState(false);

    function run() {
        startTransition(async () => {
            const receipt = await sendPremiumCommand(command);
            if (!receipt) return;
            showReceipt(receipt, successMessage(command.type));
            router.refresh();
        });
    }

    const destructive =
        command.type === 'REVOKE_INVITATION' ||
        command.type === 'REVOKE_GRANT';

    return (
        <>
            <LoadingButton
                {...buttonProps}
                type="button"
                loading={pending}
                loadingLabel="Working…"
                disabled={buttonProps.disabled}
                onClick={() => {
                    if (confirmMessage) {
                        setConfirmOpen(true);
                        return;
                    }
                    run();
                }}
            >
                {children}
            </LoadingButton>
            {confirmMessage ? (
                <ActionConfirmDialog
                    open={confirmOpen}
                    onOpenChange={setConfirmOpen}
                    title={destructive ? 'Confirm access change' : 'Confirm new invitation link'}
                    description={confirmMessage}
                    confirmLabel={destructive ? 'Confirm revoke' : 'Send new link'}
                    variant={destructive ? 'destructive' : 'default'}
                    busy={pending}
                    onConfirm={() => {
                        setConfirmOpen(false);
                        run();
                    }}
                />
            ) : null}
        </>
    );
}

async function sendPremiumCommand(command: PremiumAdminCommand) {
    try {
        const response = await fetch('/api/admin/premium/commands', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                [ADMIN_REQUEST_HEADER]: '1',
                [ADMIN_IDEMPOTENCY_HEADER]: crypto.randomUUID(),
            },
            body: JSON.stringify(command),
        });
        const payload = (await response.json().catch(() => null)) as
            | CommandResponse
            | null;
        if (!response.ok || !payload) {
            throw new Error(payload?.error ?? 'Premium command failed');
        }
        return payload;
    } catch (error) {
        toast.error(
            error instanceof Error ? error.message : 'Premium command failed'
        );
        return null;
    }
}

function showReceipt(
    receipt: PremiumAdminCommandReceipt,
    mutationMessage: string
) {
    if (receipt.delivery?.status === 'SENT') {
        toast.success(
            receipt.replayed ? 'Invitation was already sent' : 'Invitation sent'
        );
        return;
    }
    if (receipt.delivery?.status === 'AMBIGUOUS') {
        toast.warning(
            'The provider could not confirm delivery. The same link remains valid; use Resend to retry safely.'
        );
        return;
    }
    if (receipt.delivery?.status === 'FAILED') {
        toast.error(
            receipt.delivery.message ??
                'The invitation was saved, but email delivery failed. Use Resend to retry safely.'
        );
        return;
    }
    if (receipt.delivery?.status === 'SENDING') {
        toast.info('Invitation delivery is already in progress');
        return;
    }
    toast.success(receipt.replayed ? 'Command already applied' : mutationMessage);
}

function successMessage(type: PremiumAdminCommand['type']) {
    switch (type) {
        case 'RESEND_INVITATION':
            return 'Invitation resend accepted';
        case 'REVOKE_INVITATION':
            return 'Invitation revoked';
        case 'REVOKE_GRANT':
            return 'Complimentary access revoked';
        default:
            return 'Premium command accepted';
    }
}
