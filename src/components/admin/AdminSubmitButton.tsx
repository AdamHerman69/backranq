'use client';

import { useFormStatus } from 'react-dom';
import { Button, type ButtonProps } from '@/components/ui/button';

export function AdminSubmitButton({
    pendingLabel,
    confirmMessage,
    children,
    ...props
}: ButtonProps & { pendingLabel: string; confirmMessage?: string }) {
    const { pending } = useFormStatus();
    return (
        <Button
            {...props}
            type="submit"
            disabled={pending || props.disabled}
            onClick={(event) => {
                props.onClick?.(event);
                if (
                    !event.defaultPrevented &&
                    confirmMessage &&
                    !window.confirm(confirmMessage)
                ) {
                    event.preventDefault();
                }
            }}
        >
            {pending ? pendingLabel : children}
        </Button>
    );
}
