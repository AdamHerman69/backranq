"use client";

import { usePathname, useRouter } from "next/navigation";

import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

export function TrainerModeTabs({
  mode,
}: {
  mode: "quick" | "reviewFailed";
}) {
  const router = useRouter();
  const pathname = usePathname();

  return (
    <Tabs
      value={mode}
      onValueChange={(v) => {
        if (v !== "quick" && v !== "reviewFailed") return;
        const qs = v === "reviewFailed" ? "?mode=review" : "?mode=quick";
        router.push(`${pathname}${qs}`);
      }}
    >
      <TabsList>
        <TabsTrigger value="quick">Quick Play</TabsTrigger>
        <TabsTrigger value="reviewFailed">Review Failed</TabsTrigger>
      </TabsList>
    </Tabs>
  );
}

