"use client";

import * as React from "react";
import { usePathname } from "next/navigation";

import { AppNav } from "@/components/nav/AppNav";

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const hideChrome = pathname === "/login";

  if (hideChrome) return <>{children}</>;

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-40 w-full border-b bg-background/80 backdrop-blur">
        <div className="container flex h-14 items-center justify-between gap-3">
          <AppNav />
        </div>
      </header>
      <main className="container py-6">{children}</main>
    </div>
  );
}
