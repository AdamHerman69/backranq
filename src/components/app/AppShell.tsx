"use client";

import * as React from "react";
import { usePathname } from "next/navigation";

import { AppNav } from "@/components/nav/AppNav";
import { MobileBottomNav } from "@/components/nav/MobileBottomNav";
import { schedulePostInteractiveTask } from "@/lib/browser/postInteractive";
import { cn } from "@/lib/utils";

function DeferredBackgroundAnalysisBar() {
  const [AnalysisBar, setAnalysisBar] = React.useState<React.ComponentType | null>(null);

  React.useEffect(() => {
    let disposed = false;
    const load = () => {
      void import("@/components/analysis/BackgroundAnalysisBar")
        .then((module) => {
          if (!disposed) {
            setAnalysisBar(() => module.BackgroundAnalysisBar);
          }
        })
        .catch(() => {
          // This status surface is non-critical. A failed lazy chunk (for
          // example while the device goes offline) must not replace the page.
        });
    };
    const cancelScheduledLoad = schedulePostInteractiveTask(load, {
      minimumDelayMs: 1_500,
      requireFastConnection: true,
    });
    return () => {
      disposed = true;
      cancelScheduledLoad();
    };
  }, []);

  return AnalysisBar ? <AnalysisBar /> : null;
}

function shellMode(pathname: string): "app" | "workspace" | "reading" | "admin" {
  if (pathname === "/admin" || pathname.startsWith("/admin/")) return "admin";
  if (
    pathname === "/practice" ||
    pathname.startsWith("/practice/") ||
    pathname === "/play" ||
    pathname.startsWith("/play/") ||
    pathname === "/~offline/coach" ||
    /^\/games\/[^/]+/.test(pathname)
  ) {
    return "workspace";
  }
  if (
    pathname === "/settings" ||
    pathname.startsWith("/settings/") ||
    pathname === "/profile" ||
    pathname.startsWith("/profile/")
  ) {
    return "reading";
  }
  return "app";
}

const containerClassByMode = {
  app: "app-container",
  workspace: "workspace-container",
  reading: "reading-container",
  admin: "workspace-container max-w-[1536px]",
} as const;

export function AppShell({
  children,
  disableBackgroundAnalysisBar = false,
}: {
  children: React.ReactNode;
  disableBackgroundAnalysisBar?: boolean;
}) {
  const pathname = usePathname();

  const mode = shellMode(pathname);
  const isAdmin = mode === "admin";

  return (
    <div
      className="min-h-dvh bg-background"
      data-app-shell="true"
      data-shell-mode={mode}
    >
      <header className="sticky top-0 z-40 w-full border-b border-border/80 bg-background/[0.88] shadow-control backdrop-blur-xl supports-[backdrop-filter]:bg-background/75">
        <div className="app-container flex h-12 items-center justify-between gap-2 sm:h-14">
          <AppNav />
        </div>
      </header>

      <MobileBottomNav pathname={pathname} />

      {disableBackgroundAnalysisBar || isAdmin ? null : (
        <div className="relative z-30" data-background-analysis-host="true">
          <DeferredBackgroundAnalysisBar />
        </div>
      )}

      <main
        className={cn(
          containerClassByMode[mode],
          "py-4 pb-[calc(5.25rem+env(safe-area-inset-bottom))] sm:py-6 lg:pb-10",
          mode === "workspace" && "py-3 sm:py-5 lg:py-6"
        )}
      >
        {children}
      </main>
    </div>
  );
}
