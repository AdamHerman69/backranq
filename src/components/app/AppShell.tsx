"use client";

import * as React from "react";
import { usePathname } from "next/navigation";

import { BackgroundAnalysisBar } from "@/components/analysis/BackgroundAnalysisBar";
import { AppNav, MobileBottomNav } from "@/components/nav/AppNav";
import { cn } from "@/lib/utils";

function isPublicRoute(pathname: string) {
  return (
    pathname === "/" ||
    pathname === "/login" ||
    pathname === "/privacy" ||
    pathname === "/terms" ||
    pathname === "/support" ||
    pathname.startsWith("/invite/")
  );
}

function isKnownAppRoute(pathname: string) {
  return [
    "/home",
    "/practice",
    "/play",
    "/games",
    "/progress",
    "/settings",
    "/profile",
    "/admin",
    "/~offline/coach",
  ].some((route) => pathname === route || pathname.startsWith(`${route}/`));
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
  admin: "mx-auto w-full max-w-[1536px] px-3 sm:px-5 lg:px-8",
} as const;

export function AppShell({
  children,
  disableBackgroundAnalysisBar = false,
}: {
  children: React.ReactNode;
  disableBackgroundAnalysisBar?: boolean;
}) {
  const pathname = usePathname();
  const [mobileMenuOpen, setMobileMenuOpen] = React.useState(false);

  if (isPublicRoute(pathname) || !isKnownAppRoute(pathname)) {
    return <>{children}</>;
  }

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
          <AppNav onMobileMenuOpenChange={setMobileMenuOpen} />
        </div>
      </header>

      <MobileBottomNav pathname={pathname} hidden={mobileMenuOpen} />

      {disableBackgroundAnalysisBar || isAdmin ? null : (
        <div className="relative z-30">
          <BackgroundAnalysisBar />
        </div>
      )}

      <main
        className={cn(
          containerClassByMode[mode],
          "animate-soft-enter py-4 pb-[calc(5.25rem+env(safe-area-inset-bottom))] sm:py-6 lg:pb-8",
          mode === "workspace" && "sm:py-5 lg:py-6"
        )}
      >
        {children}
      </main>
    </div>
  );
}
