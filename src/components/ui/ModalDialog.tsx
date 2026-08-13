'use client';

import type { ReactNode } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';

import { cn } from '@/lib/utils';

export function ModalDialog({
    open,
    onOpenChange,
    title,
    description,
    children,
    className,
    bodyClassName,
    onOpenAutoFocus,
    onCloseAutoFocus,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
    description?: string;
    children: ReactNode;
    className?: string;
    bodyClassName?: string;
    onOpenAutoFocus?: (event: Event) => void;
    onCloseAutoFocus?: (event: Event) => void;
}) {
    return (
        <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
            <DialogPrimitive.Portal>
                <DialogPrimitive.Overlay className="fixed inset-0 z-[200] bg-black/70" />
                <DialogPrimitive.Content
                    {...(!description
                        ? { 'aria-describedby': undefined }
                        : {})}
                    className={cn(
                        'fixed left-1/2 top-1/2 z-[210] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border bg-background p-5 shadow-xl focus:outline-none focus:ring-2 focus:ring-ring',
                        className
                    )}
                    onOpenAutoFocus={onOpenAutoFocus}
                    onCloseAutoFocus={onCloseAutoFocus}
                >
                    <DialogPrimitive.Title className="pr-8 text-lg font-semibold">
                        {title}
                    </DialogPrimitive.Title>
                    {description ? (
                        <DialogPrimitive.Description
                            className="mt-1 text-sm text-muted-foreground"
                        >
                            {description}
                        </DialogPrimitive.Description>
                    ) : null}
                    <div className={cn('mt-4', bodyClassName)}>{children}</div>
                    <DialogPrimitive.Close
                        className="absolute right-4 top-4 rounded-sm opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring"
                        aria-label="Close"
                    >
                        <X className="h-4 w-4" />
                    </DialogPrimitive.Close>
                </DialogPrimitive.Content>
            </DialogPrimitive.Portal>
        </DialogPrimitive.Root>
    );
}
