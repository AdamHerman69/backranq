'use client';

import { useFormStatus } from 'react-dom';
import type { ButtonProps } from '@/components/ui/button';
import { LoadingButton } from '@/components/ui/loading-button';

export function AdminSubmitButton({
    pendingLabel,
    confirmMessage,
    children,
    ...props
}: ButtonProps & { pendingLabel: string; confirmMessage?: string }) {
    const { pending } = useFormStatus();
    return (
        <LoadingButton
            {...props}
            type="submit"
            loading={pending}
            loadingLabel={pendingLabel}
            disabled={props.disabled}
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
            {children}
        </LoadingButton>
    );
}
