import * as React from "react";
import {
  AlertCircle,
  CheckCircle2,
  CircleAlert,
  Inbox,
  Info,
} from "lucide-react";

import { Card } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

type StateTone = "neutral" | "info" | "success" | "warning" | "danger";

const toneClasses: Record<StateTone, string> = {
  neutral: "border-border bg-surface-subtle text-foreground",
  info: "border-info/25 bg-info/5 text-foreground",
  success: "border-success/25 bg-success/5 text-foreground",
  warning: "border-warning/30 bg-warning/10 text-foreground",
  danger: "border-destructive/25 bg-destructive/5 text-foreground",
};

const iconClasses: Record<StateTone, string> = {
  neutral: "text-muted-foreground",
  info: "text-info",
  success: "text-success",
  warning: "text-warning",
  danger: "text-destructive",
};

const defaultIcons: Record<StateTone, React.ReactNode> = {
  neutral: <Info aria-hidden="true" />,
  info: <Info aria-hidden="true" />,
  success: <CheckCircle2 aria-hidden="true" />,
  warning: <CircleAlert aria-hidden="true" />,
  danger: <AlertCircle aria-hidden="true" />,
};

export function InlineStatus({
  children,
  tone = "neutral",
  icon,
  className,
  live = false,
}: {
  children: React.ReactNode;
  tone?: StateTone;
  icon?: React.ReactNode;
  className?: string;
  live?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex min-h-11 items-start gap-2.5 rounded-md border px-3 py-2.5 text-sm leading-relaxed",
        toneClasses[tone],
        className
      )}
      role={tone === "danger" ? "alert" : live ? "status" : undefined}
      aria-live={live && tone !== "danger" ? "polite" : undefined}
    >
      <span
        className={cn(
          "mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center [&_svg]:h-4 [&_svg]:w-4",
          iconClasses[tone]
        )}
      >
        {icon ?? defaultIcons[tone]}
      </span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function StatePanel({
  title,
  description,
  action,
  icon,
  tone = "neutral",
  className,
  role,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  icon: React.ReactNode;
  tone?: StateTone;
  className?: string;
  role?: "status" | "alert";
}) {
  return (
    <Card
      variant="subtle"
      className={cn("border", toneClasses[tone], className)}
      role={role}
      aria-live={role === "status" ? "polite" : undefined}
    >
      <div className="flex flex-col items-center px-5 py-9 text-center sm:px-8">
        <span
          className={cn(
            "mb-4 inline-flex h-11 w-11 items-center justify-center rounded-full bg-card shadow-control [&_svg]:h-5 [&_svg]:w-5",
            iconClasses[tone]
          )}
        >
          {icon}
        </span>
        <h2 className="text-base font-semibold tracking-[-0.01em]">{title}</h2>
        {description ? (
          <p className="mt-1.5 max-w-xl text-sm leading-relaxed text-muted-foreground">
            {description}
          </p>
        ) : null}
        {action ? <div className="mt-5">{action}</div> : null}
      </div>
    </Card>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  icon?: React.ReactNode;
  className?: string;
}) {
  return (
    <StatePanel
      title={title}
      description={description}
      action={action}
      icon={icon ?? <Inbox aria-hidden="true" />}
      className={className}
    />
  );
}

export function ErrorState({
  title,
  description,
  action,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <StatePanel
      title={title}
      description={description}
      action={action}
      icon={<AlertCircle aria-hidden="true" />}
      tone="danger"
      role="alert"
      className={className}
    />
  );
}

export function LoadingState({
  title = "Preparing your next step",
  description,
  className,
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  className?: string;
}) {
  return (
    <StatePanel
      title={title}
      description={description}
      icon={<Spinner className="h-5 w-5" label={String(title)} />}
      tone="info"
      role="status"
      className={className}
    />
  );
}
