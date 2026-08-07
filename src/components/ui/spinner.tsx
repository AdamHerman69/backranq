import { LoaderCircle } from "lucide-react";

import { cn } from "@/lib/utils";

export function Spinner({
  className,
  label = "Loading",
}: {
  className?: string;
  label?: string;
}) {
  return (
    <span className="inline-flex items-center justify-center" role="status">
      <LoaderCircle
        className={cn("h-4 w-4 animate-spin", className)}
        aria-hidden="true"
      />
      <span className="sr-only">{label}</span>
    </span>
  );
}
