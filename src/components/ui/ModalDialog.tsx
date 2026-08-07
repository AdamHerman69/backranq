'use client';

import * as React from 'react';
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
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
    description?: string;
    children: React.ReactNode;
    className?: string;
}) {
    const descriptionId = React.useId();

    return (
        <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
            <DialogPrimitive.Portal>
                <DialogPrimitive.Overlay className="fixed inset-0 z-[200] bg-black/70" />
                <DialogPrimitive.Content
                    aria-describedby={
                        description ? descriptionId : undefined
                    }
                    className={cn(
                        'fixed left-1/2 top-1/2 z-[210] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border bg-background p-5 shadow-xl focus:outline-none focus:ring-2 focus:ring-ring',
                        className
                    )}
                >
                    <DialogPrimitive.Title className="pr-8 text-lg font-semibold">
                        {title}
                    </DialogPrimitive.Title>
                    {description ? (
                        <DialogPrimitive.Description
                            id={descriptionId}
                            className="mt-1 text-sm text-muted-foreground"
                        >
                            {description}
                        </DialogPrimitive.Description>
                    ) : null}
                    <div className="mt-4">{children}</div>
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
