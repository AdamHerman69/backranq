"use client";

import type { LucideIcon } from "lucide-react";
import {
  House,
  Library,
  LineChart,
  LogOut,
  Settings,
  Swords,
  Target,
  User2,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession } from "next-auth/react";
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

export function MobileBottomNav({
  pathname,
}: {
  pathname: string;
}) {
  return (
    <nav
      aria-label="Main tabs"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-foreground/10 bg-background/[0.94] px-2 pb-[env(safe-area-inset-bottom)] shadow-[0_-16px_40px_-32px_hsl(var(--foreground)/0.45)] backdrop-blur-xl lg:hidden"
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
                "group relative flex min-w-0 flex-col items-center justify-center gap-0.5 px-1 text-[10px] font-medium transition-[color,transform] duration-fast ease-standard focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset motion-safe:active:scale-[0.96]",
                active ? "text-primary" : "text-muted-foreground"
              )}
            >
              <span
                className={cn(
                  "absolute left-1/2 top-0 h-0.5 w-8 -translate-x-1/2 bg-primary transition-[opacity,transform] duration-base ease-emphasized",
                  active ? "scale-x-100 opacity-100" : "scale-x-0 opacity-0"
                )}
                aria-hidden="true"
              />
              <Icon
                className={cn(
                  "relative h-[1.15rem] w-[1.15rem] transition-transform duration-fast",
                  active && "motion-safe:-translate-y-px"
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

export function AppNav() {
  const pathname = usePathname();
  const { data } = useSession();
  const authed = Boolean(data?.user?.id);
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
        <Button
          asChild
          variant="ghost"
          className="group h-11 gap-2 px-0.5 text-base font-semibold tracking-[-0.03em] sm:h-10 sm:px-1"
        >
          <Link href="/home" aria-label="Backranq home">
            <span
              className="relative inline-flex h-7 w-7 items-center justify-center overflow-hidden rounded-sm bg-foreground text-[10px] font-bold text-background shadow-control transition-transform duration-fast after:absolute after:-right-1 after:-top-1 after:h-2.5 after:w-2.5 after:rounded-full after:bg-accent motion-safe:group-hover:-rotate-2"
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
                variant="ghost"
                size="sm"
                className={cn(
                  "relative rounded-none px-3 text-sm after:absolute after:inset-x-3 after:-bottom-[7px] after:h-0.5 after:origin-center after:bg-primary after:transition-transform",
                  active
                    ? "text-foreground after:scale-x-100"
                    : "text-muted-foreground after:scale-x-0 hover:text-foreground"
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
        <NotificationBell ownerId={data?.user?.id ?? null} />
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
