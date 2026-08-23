import Link from 'next/link';

import {
    itemIsActive,
    primaryNavItems,
} from '@/components/nav/appNavItems';
import { cn } from '@/lib/utils';

export function MobileBottomNav({ pathname }: { pathname: string }) {
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
                    prefetch={false}
                            aria-current={active ? 'page' : undefined}
                            className={cn(
                                'group relative flex min-w-0 flex-col items-center justify-center gap-0.5 px-1 text-[10px] font-medium transition-[color,transform] duration-fast ease-standard focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset motion-safe:active:scale-[0.96]',
                                active
                                    ? 'text-primary'
                                    : 'text-muted-foreground'
                            )}
                        >
                            <span
                                className={cn(
                                    'absolute left-1/2 top-0 h-0.5 w-8 -translate-x-1/2 bg-primary transition-[opacity,transform] duration-base ease-emphasized',
                                    active
                                        ? 'scale-x-100 opacity-100'
                                        : 'scale-x-0 opacity-0'
                                )}
                                aria-hidden="true"
                            />
                            <Icon
                                className={cn(
                                    'relative h-[1.15rem] w-[1.15rem] transition-transform duration-fast',
                                    active && 'motion-safe:-translate-y-px'
                                )}
                                strokeWidth={active ? 2.25 : 1.8}
                                aria-hidden="true"
                            />
                            <span className="relative truncate">
                                {item.label}
                            </span>
                        </Link>
                    );
                })}
            </div>
        </nav>
    );
}
