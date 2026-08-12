'use client';

import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export type ActionConfirmDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
    description: string;
    confirmLabel: string;
    onConfirm: () => void | Promise<void>;
    cancelLabel?: string;
    variant?: 'default' | 'destructive';
    busy?: boolean;
    allowCloseWhileBusy?: boolean;
    confirmDisabled?: boolean;
    children?: React.ReactNode;
};

export function ActionConfirmDialog({
    open,
    onOpenChange,
    title,
    description,
    confirmLabel,
    onConfirm,
    cancelLabel = 'Cancel',
    variant = 'default',
    busy = false,
    allowCloseWhileBusy = false,
    confirmDisabled = false,
    children,
}: ActionConfirmDialogProps) {
    const closeDisabled = busy && !allowCloseWhileBusy;

    return (
        <DialogPrimitive.Root
            open={open}
            onOpenChange={(nextOpen) => {
                if (!closeDisabled) onOpenChange(nextOpen);
            }}
        >
            <DialogPrimitive.Portal>
                <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/70 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
                <DialogPrimitive.Content
                    role="alertdialog"
                    aria-busy={busy}
                    className={cn(
                        'fixed left-1/2 top-1/2 z-50 grid w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 gap-5 rounded-lg border bg-background p-6 shadow-lg',
                        'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95'
                    )}
                    onEscapeKeyDown={(event) => {
                        if (closeDisabled) event.preventDefault();
                    }}
                    onInteractOutside={(event) => {
                        if (closeDisabled) event.preventDefault();
                    }}
                >
                    <div className="space-y-2 pr-8">
                        <DialogPrimitive.Title className="text-lg font-semibold">
                            {title}
                        </DialogPrimitive.Title>
                        <DialogPrimitive.Description className="text-sm text-muted-foreground">
                            {description}
                        </DialogPrimitive.Description>
                    </div>

                    {children}

                    <div className="sr-only" role="status" aria-live="polite">
                        {busy
                            ? 'Request in progress. You may close this dialog while Backranq continues in the background.'
                            : ''}
                    </div>

                    <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                        <Button
                            type="button"
                            variant="outline"
                            disabled={closeDisabled}
                            onClick={() => onOpenChange(false)}
                        >
                            {busy && allowCloseWhileBusy ? 'Close' : cancelLabel}
                        </Button>
                        <Button
                            type="button"
                            variant={variant}
                            disabled={busy || confirmDisabled}
                            onClick={() => void onConfirm()}
                        >
                            {busy ? 'Working…' : confirmLabel}
                        </Button>
                    </div>

                    <DialogPrimitive.Close
                        className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none disabled:opacity-40"
                        disabled={closeDisabled}
                        aria-label="Close"
                    >
                        <X className="h-4 w-4" aria-hidden="true" />
                    </DialogPrimitive.Close>
                </DialogPrimitive.Content>
            </DialogPrimitive.Portal>
        </DialogPrimitive.Root>
    );
}
