"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut, useSession } from "next-auth/react";
import { LogOut, Menu, Settings, User2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";

type NavItem = {
  href: string;
  label: string;
  active?: (pathname: string) => boolean;
};

const navItems: NavItem[] = [
  {
    href: "/dashboard",
    label: "Dashboard",
    active: (p) => p === "/dashboard" || p.startsWith("/dashboard/"),
  },
  {
    href: "/puzzles",
    label: "Train",
    active: (p) =>
      p === "/puzzles" ||
      (p.startsWith("/puzzles/") && !p.startsWith("/puzzles/library")),
  },
  {
    href: "/games",
    label: "Games",
    active: (p) => p === "/games" || p.startsWith("/games/"),
  },
  {
    href: "/puzzles/library",
    label: "Puzzles",
    active: (p) => p === "/puzzles/library" || p.startsWith("/puzzles/library/"),
  },
  {
    href: "/settings",
    label: "Settings",
    active: (p) => p === "/settings" || p.startsWith("/settings/"),
  },
];

function initials(nameOrEmail: string) {
  const parts = nameOrEmail.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]?.slice(0, 2).toUpperCase() ?? "?";
  const a = parts[0]?.[0] ?? "";
  const b = parts[parts.length - 1]?.[0] ?? "";
  return `${a}${b}`.toUpperCase() || "?";
}

function NavLinkButton({
  href,
  label,
  active,
}: {
  href: string;
  label: string;
  active: boolean;
}) {
  return (
    <Button
      asChild
      variant={active ? "secondary" : "ghost"}
      className={cn("w-full justify-start", !active && "text-muted-foreground")}
    >
      <Link href={href}>{label}</Link>
    </Button>
  );
}

export function AppNav() {
  const pathname = usePathname();
  const { data } = useSession();
  const authed = !!data?.user?.id;
  const user = data?.user;
  const label = user?.name ?? user?.email ?? "User";

  return (
    <>
      <div className="flex items-center gap-3">
        <Button asChild variant="ghost" className="px-2 text-base font-semibold">
          <Link href="/dashboard" aria-label="BackRank">
            BackRank
          </Link>
        </Button>

        <nav className="hidden items-center gap-1 md:flex">
          {navItems.map((it) => {
            const isActive = it.active ? it.active(pathname) : pathname === it.href;
            return (
              <Button
                key={it.href}
                asChild
                variant={isActive ? "secondary" : "ghost"}
                className={cn(!isActive && "text-muted-foreground")}
              >
                <Link href={it.href}>{it.label}</Link>
              </Button>
            );
          })}
        </nav>
      </div>

      <div className="flex items-center gap-2">
        <Sheet>
          <SheetTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="md:hidden"
              aria-label="Open menu"
            >
              <Menu />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="p-0">
            <div className="p-6">
              <SheetHeader>
                <SheetTitle>BackRank</SheetTitle>
              </SheetHeader>

              <div className="mt-4 flex flex-col gap-1">
                {navItems.map((it) => {
                  const isActive = it.active ? it.active(pathname) : pathname === it.href;
                  return (
                    <NavLinkButton
                      key={it.href}
                      href={it.href}
                      label={it.label}
                      active={isActive}
                    />
                  );
                })}
              </div>

              <div className="mt-6">
                {authed ? (
                  <Button
                    variant="outline"
                    className="w-full justify-start"
                    onClick={() => signOut({ callbackUrl: "/" })}
                  >
                    <LogOut className="mr-2" />
                    Sign out
                  </Button>
                ) : (
                  <Button asChild className="w-full justify-start">
                    <Link href="/login">Sign in</Link>
                  </Button>
                )}
              </div>
            </div>
          </SheetContent>
        </Sheet>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="h-9 px-2">
              <Avatar className="h-7 w-7">
                <AvatarImage src={user?.image ?? undefined} alt={label} />
                <AvatarFallback>{initials(label)}</AvatarFallback>
              </Avatar>
              <span className="ml-2 hidden text-sm font-medium md:inline">{label}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel className="font-normal">
              <div className="flex flex-col space-y-1">
                <p className="text-sm font-medium leading-none">{label}</p>
                {user?.email ? (
                  <p className="text-xs leading-none text-muted-foreground">{user.email}</p>
                ) : null}
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href="/profile">
                <User2 className="mr-2" />
                Profile
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href="/settings">
                <Settings className="mr-2" />
                Settings
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {authed ? (
              <DropdownMenuItem onSelect={() => signOut({ callbackUrl: "/" })}>
                <LogOut className="mr-2" />
                Sign out
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem asChild>
                <Link href="/login">Sign in</Link>
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </>
  );
}
