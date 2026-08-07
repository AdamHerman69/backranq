"use client";

import type { LucideIcon } from "lucide-react";
import {
  House,
  Library,
  LineChart,
  LogOut,
  Menu,
  Settings,
  Swords,
  Target,
  User2,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession } from "next-auth/react";
import { useState } from "react";
import { toast } from "sonner";

import { NotificationBell } from "@/components/notifications/NotificationBell";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { signOutAndClearCoachSession } from "@/lib/coach/signOut";
import { cn } from "@/lib/utils";

type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  active?: (pathname: string) => boolean;
};

export const appNavItems: NavItem[] = [
  {
    href: "/home",
    label: "Home",
    icon: House,
    active: (p) => p === "/home" || p.startsWith("/home/"),
  },
  {
    href: "/practice",
    label: "Practice",
    icon: Target,
    active: (p) => p === "/practice" || p.startsWith("/practice/"),
  },
  {
    href: "/play",
    label: "Play",
    icon: Swords,
    active: (p) => p === "/play" || p.startsWith("/play/"),
  },
  {
    href: "/games",
    label: "Games",
    icon: Library,
    active: (p) => p === "/games" || p.startsWith("/games/"),
  },
  {
    href: "/progress",
    label: "Progress",
    icon: LineChart,
    active: (p) => p === "/progress" || p.startsWith("/progress/"),
  },
  {
    href: "/settings",
    label: "Settings",
    icon: Settings,
    active: (p) => p === "/settings" || p.startsWith("/settings/"),
  },
];

const primaryNavItems = appNavItems.filter((item) => item.href !== "/settings");

function initials(nameOrEmail: string) {
  const parts = nameOrEmail.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]?.slice(0, 2).toUpperCase() ?? "?";
  const a = parts[0]?.[0] ?? "";
  const b = parts[parts.length - 1]?.[0] ?? "";
  return `${a}${b}`.toUpperCase() || "?";
}

function itemIsActive(item: NavItem, pathname: string) {
  return item.active ? item.active(pathname) : pathname === item.href;
}

function NavLinkButton({
  item,
  pathname,
  onNavigate,
}: {
  item: NavItem;
  pathname: string;
  onNavigate?: () => void;
}) {
  const active = itemIsActive(item, pathname);
  const Icon = item.icon;
  return (
    <Button
      asChild
      variant={active ? "quiet" : "ghost"}
      className={cn(
        "min-h-11 w-full justify-start",
        !active && "text-muted-foreground"
      )}
    >
      <Link
        href={item.href}
        aria-current={active ? "page" : undefined}
        onClick={onNavigate}
      >
        <Icon aria-hidden="true" />
        {item.label}
      </Link>
    </Button>
  );
}

export function MobileBottomNav({
  pathname,
  hidden = false,
}: {
  pathname: string;
  hidden?: boolean;
}) {
  return (
    <nav
      aria-label="Main tabs"
      className={cn(
        "fixed inset-x-0 bottom-0 z-40 border-t border-border/80 bg-background/[0.92] px-1.5 pb-[env(safe-area-inset-bottom)] shadow-[0_-12px_32px_-24px_hsl(var(--foreground)/0.35)] backdrop-blur-xl lg:hidden",
        hidden && "hidden"
      )}
    >
      <div className="mx-auto grid h-16 max-w-xl grid-cols-5">
        {primaryNavItems.map((item) => {
          const active = itemIsActive(item, pathname);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "group relative flex min-w-0 flex-col items-center justify-center gap-0.5 rounded-lg px-1 text-[10px] font-medium transition-[color,transform] duration-fast ease-standard focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset motion-safe:active:scale-[0.96]",
                active ? "text-primary" : "text-muted-foreground"
              )}
            >
              <span
                className={cn(
                  "absolute inset-x-2 top-1.5 h-8 rounded-full bg-primary/[0.09] transition-[opacity,transform] duration-base ease-emphasized",
                  active ? "scale-100 opacity-100" : "scale-75 opacity-0"
                )}
                aria-hidden="true"
              />
              <Icon
                className={cn(
                  "relative h-5 w-5 transition-transform duration-fast",
                  active && "motion-safe:-translate-y-0.5"
                )}
                strokeWidth={active ? 2.25 : 1.8}
                aria-hidden="true"
              />
              <span className="relative truncate">{item.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

export function AppNav({
  onMobileMenuOpenChange,
}: {
  onMobileMenuOpenChange?: (open: boolean) => void;
}) {
  const pathname = usePathname();
  const { data } = useSession();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const authed = !!data?.user?.id;
  const user = data?.user;
  const label = user?.name ?? user?.email ?? "User";

  const signOutFromDevice = async () => {
    try {
      await signOutAndClearCoachSession(data?.user?.id);
    } catch {
      toast.error("Could not sign out. Your local coach game was left intact.");
    }
  };

  return (
    <>
      <div className="flex min-w-0 items-center gap-1.5 sm:gap-3">
        <Sheet
          open={mobileMenuOpen}
          onOpenChange={(open) => {
            setMobileMenuOpen(open);
            onMobileMenuOpenChange?.(open);
          }}
        >
          <SheetTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="lg:hidden"
              aria-label="Open menu"
            >
              <Menu aria-hidden="true" />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="p-0">
            <div className="p-5 sm:p-6">
              <SheetHeader>
                <SheetTitle className="flex items-center gap-2.5">
                  <span
                    className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-foreground text-xs font-bold text-background shadow-control"
                    aria-hidden="true"
                  >
                    B
                  </span>
                  Backranq
                </SheetTitle>
                <SheetDescription>
                  Practice the decisions from your own games.
                </SheetDescription>
              </SheetHeader>

              <nav aria-label="Primary" className="mt-6 flex flex-col gap-1">
                {appNavItems.map((item) => (
                  <NavLinkButton
                    key={item.href}
                    item={item}
                    pathname={pathname}
                    onNavigate={() => setMobileMenuOpen(false)}
                  />
                ))}
              </nav>

              <div className="mt-6 border-t pt-5">
                {authed ? (
                  <Button
                    variant="outline"
                    className="min-h-11 w-full justify-start"
                    onClick={() => void signOutFromDevice()}
                  >
                    <LogOut aria-hidden="true" />
                    Sign out
                  </Button>
                ) : (
                  <Button asChild className="min-h-11 w-full justify-start">
                    <Link href="/login">Sign in</Link>
                  </Button>
                )}
              </div>
            </div>
          </SheetContent>
        </Sheet>

        <Button
          asChild
          variant="ghost"
          className="group h-11 gap-2 px-1.5 text-base font-semibold tracking-[-0.02em] sm:h-10 sm:px-2"
        >
          <Link href="/home" aria-label="Backranq home">
            <span
              className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-foreground text-[11px] font-bold text-background shadow-control transition-transform duration-fast motion-safe:group-hover:-rotate-2"
              aria-hidden="true"
            >
              B
            </span>
            <span className="hidden sm:inline">Backranq</span>
          </Link>
        </Button>

        <nav aria-label="Primary" className="hidden items-center gap-0.5 lg:flex">
          {primaryNavItems.map((item) => {
            const active = itemIsActive(item, pathname);
            return (
              <Button
                key={item.href}
                asChild
                variant={active ? "quiet" : "ghost"}
                size="sm"
                className={cn(
                  "relative px-3 text-sm",
                  !active && "text-muted-foreground"
                )}
              >
                <Link href={item.href} aria-current={active ? "page" : undefined}>
                  {item.label}
                </Link>
              </Button>
            );
          })}
        </nav>
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-0.5 sm:gap-1">
        <NotificationBell enabled={authed} />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="xl:w-auto xl:px-2"
              aria-label="Open account menu"
            >
              <Avatar className="h-7 w-7">
                <AvatarImage
                  src={user?.image ?? undefined}
                  alt={label}
                  crossOrigin="anonymous"
                />
                <AvatarFallback>{initials(label)}</AvatarFallback>
              </Avatar>
              <span className="ml-1 hidden max-w-40 truncate text-sm font-medium xl:inline">
                {label}
              </span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60">
            <DropdownMenuLabel className="font-normal">
              <div className="flex flex-col space-y-1">
                <p className="truncate text-sm font-medium leading-none">{label}</p>
                {user?.email ? (
                  <p className="truncate text-xs leading-none text-muted-foreground">
                    {user.email}
                  </p>
                ) : null}
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href="/profile">
                <User2 className="mr-2" aria-hidden="true" />
                Profile
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href="/settings">
                <Settings className="mr-2" aria-hidden="true" />
                Settings
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {authed ? (
              <DropdownMenuItem onSelect={() => void signOutFromDevice()}>
                <LogOut className="mr-2" aria-hidden="true" />
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
