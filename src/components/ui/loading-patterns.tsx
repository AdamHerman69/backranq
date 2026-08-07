import * as React from "react";

import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export function BoardSkeleton({
  className,
  label = "Loading chessboard",
}: {
  className?: string;
  label?: string;
}) {
  return (
    <div
      className={cn(
        "relative aspect-square w-full overflow-hidden rounded-lg border bg-card p-1 shadow-card sm:p-2",
        className
      )}
      role="status"
      aria-label={label}
    >
      <div className="grid h-full w-full grid-cols-8 overflow-hidden rounded-md">
        {Array.from({ length: 64 }, (_, index) => {
          const row = Math.floor(index / 8);
          const column = index % 8;
          const dark = (row + column) % 2 === 1;
          return (
            <span
              key={index}
              className={
                dark ? "bg-board-dark/[0.45]" : "bg-board-light/[0.55]"
              }
              aria-hidden="true"
            />
          );
        })}
      </div>
      <div
        className="pointer-events-none absolute inset-1 animate-shimmer rounded-md bg-[linear-gradient(100deg,transparent_30%,hsl(var(--card)/0.28)_45%,transparent_60%)] bg-[length:220%_100%] sm:inset-2"
        aria-hidden="true"
      />
    </div>
  );
}

export function ListSkeleton({
  rows = 5,
  className,
}: {
  rows?: number;
  className?: string;
}) {
  return (
    <div className={cn("space-y-2", className)} aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        <Card key={index} variant="panel" className="p-4">
          <div className="flex items-center gap-3">
            <Skeleton className="h-10 w-10 shrink-0 rounded-lg" />
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-4 w-2/5" />
              <Skeleton className="h-3 w-3/4" />
            </div>
            <Skeleton className="h-9 w-20 shrink-0" />
          </div>
        </Card>
      ))}
    </div>
  );
}

export function MetricSkeleton({ className }: { className?: string }) {
  return (
    <Card variant="panel" className={cn("p-4", className)} aria-hidden="true">
      <Skeleton className="h-3 w-2/5" />
      <Skeleton className="mt-3 h-8 w-1/3" />
      <Skeleton className="mt-4 h-2 w-full rounded-full" />
    </Card>
  );
}

export function PageSkeleton({
  variant = "dashboard",
  className,
  label = "Loading page",
}: {
  variant?: "dashboard" | "list" | "workspace" | "reading";
  className?: string;
  label?: string;
}) {
  return (
    <div
      className={cn("space-y-6", className)}
      role="status"
      aria-label={label}
    >
      <div className="space-y-2" aria-hidden="true">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-full max-w-md" />
      </div>

      {variant === "workspace" ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,560px)_minmax(280px,1fr)]">
          <BoardSkeleton />
          <div className="space-y-3" aria-hidden="true">
            <Skeleton className="h-28 w-full rounded-lg" />
            <Skeleton className="h-52 w-full rounded-lg" />
          </div>
        </div>
      ) : variant === "list" ? (
        <ListSkeleton />
      ) : variant === "reading" ? (
        <Card variant="panel" className="space-y-4 p-5 sm:p-6" aria-hidden="true">
          <Skeleton className="h-5 w-1/3" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-28" />
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {Array.from({ length: 4 }, (_, index) => (
              <MetricSkeleton key={index} />
            ))}
          </div>
          <Skeleton className="h-48 w-full rounded-lg" />
        </>
      )}
      <span className="sr-only">{label}</span>
    </div>
  );
}
