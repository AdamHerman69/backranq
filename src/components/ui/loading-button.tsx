import * as React from "react";

import { Button, type ButtonProps } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

export interface LoadingButtonProps extends Omit<ButtonProps, "asChild"> {
  loading?: boolean;
  loadingLabel?: string;
}

export const LoadingButton = React.forwardRef<
  HTMLButtonElement,
  LoadingButtonProps
>(function LoadingButton(
  {
    loading = false,
    loadingLabel = "Working…",
    disabled,
    children,
    ...props
  },
  ref
) {
  return (
    <Button
      ref={ref}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? (
        <>
          <Spinner label={loadingLabel} />
          <span>{loadingLabel}</span>
        </>
      ) : (
        children
      )}
    </Button>
  );
});
