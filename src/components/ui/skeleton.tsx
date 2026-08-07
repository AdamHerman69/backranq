import * as React from "react";

import { cn } from "@/lib/utils";

function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "animate-shimmer rounded-md bg-[linear-gradient(100deg,hsl(var(--muted))_24%,hsl(var(--card))_38%,hsl(var(--muted))_52%)] bg-[length:220%_100%]",
        className
      )}
      {...props}
    />
  );
}

export { Skeleton };
