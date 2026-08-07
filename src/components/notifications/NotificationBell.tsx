'use client';

import * as React from 'react';
import Link from 'next/link';
import { Bell, CheckCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

type NotificationItem = {
    id: string;
    title: string;
    body: string;
    href: string | null;
    readAt: string | null;
    createdAt: string;
};

export function NotificationBell({ enabled }: { enabled: boolean }) {
    const [items, setItems] = React.useState<NotificationItem[]>([]);
    const [unreadCount, setUnreadCount] = React.useState(0);
    const [open, setOpen] = React.useState(false);
    const [loading, setLoading] = React.useState(enabled);
    const [loadError, setLoadError] = React.useState(false);

    const load = React.useCallback(async () => {
        if (!enabled) return;
        setLoading(true);
        try {
            const response = await fetch('/api/notifications?limit=10', {
                cache: 'no-store',
            });
            if (!response.ok) throw new Error('Notification load failed');
            const payload = (await response.json()) as {
                notifications?: NotificationItem[];
                unreadCount?: number;
            };
            setItems(payload.notifications ?? []);
            setUnreadCount(payload.unreadCount ?? 0);
            setLoadError(false);
        } catch {
            setLoadError(true);
        } finally {
            setLoading(false);
        }
    }, [enabled]);

    React.useEffect(() => {
        if (!enabled) return;
        void load();
        const timer = window.setInterval(() => {
            if (document.visibilityState === 'visible') void load();
        }, 60_000);
        return () => window.clearInterval(timer);
    }, [enabled, load]);

    async function markRead(id: string) {
        setItems((current) =>
            current.map((item) =>
                item.id === id && !item.readAt
                    ? { ...item, readAt: new Date().toISOString() }
                    : item
            )
        );
        setUnreadCount((count) => Math.max(0, count - (items.find((item) => item.id === id)?.readAt ? 0 : 1)));
        await fetch('/api/notifications', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'mark-read', id }),
        });
    }

    async function markAllRead() {
        const now = new Date().toISOString();
        setItems((current) => current.map((item) => ({ ...item, readAt: item.readAt ?? now })));
        setUnreadCount(0);
        await fetch('/api/notifications', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'mark-all-read' }),
        });
    }

    if (!enabled) return null;
    return (
        <DropdownMenu open={open} onOpenChange={(next) => { setOpen(next); if (next) void load(); }}>
            <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="relative" aria-label={`Notifications${unreadCount ? `, ${unreadCount} unread` : ''}`}>
                    <Bell />
                    {unreadCount > 0 ? (
                        <Badge className="absolute -right-1 -top-1 min-w-5 justify-center px-1 text-[10px]" aria-hidden="true">
                            {unreadCount > 99 ? '99+' : unreadCount}
                        </Badge>
                    ) : null}
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-[min(24rem,calc(100vw-1rem))] p-0">
                <div className="flex items-center justify-between border-b px-4 py-3">
                    <p className="font-semibold">Notifications</p>
                    {unreadCount > 0 ? (
                        <Button variant="ghost" size="sm" onClick={() => void markAllRead()}>
                            <CheckCheck className="mr-1 h-4 w-4" /> Mark all read
                        </Button>
                    ) : null}
                </div>
                <div className="max-h-[26rem] overflow-y-auto">
                    {loading && items.length === 0 ? (
                        <div
                            className="space-y-4 p-4"
                            role="status"
                            aria-label="Loading notifications"
                        >
                            {Array.from({ length: 3 }).map((_, index) => (
                                <div key={index} className="space-y-2">
                                    <Skeleton className="h-4 w-2/5" />
                                    <Skeleton className="h-3 w-full" />
                                    <Skeleton className="h-3 w-1/4" />
                                </div>
                            ))}
                        </div>
                    ) : loadError && items.length === 0 ? (
                        <div className="p-6 text-center" role="alert">
                            <p className="text-sm text-muted-foreground">
                                Notifications could not be loaded.
                            </p>
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="mt-3"
                                onClick={() => void load()}
                            >
                                Try again
                            </Button>
                        </div>
                    ) : items.length === 0 ? (
                        <p className="p-6 text-center text-sm text-muted-foreground">You are all caught up.</p>
                    ) : (
                        items.map((item) => (
                            <Link
                                key={item.id}
                                href={item.href ?? '/home'}
                                onClick={() => { void markRead(item.id); setOpen(false); }}
                                className="relative block border-b px-4 py-3 last:border-0 hover:bg-muted/50"
                            >
                                {!item.readAt ? <span className="absolute left-1.5 top-5 h-2 w-2 rounded-full bg-primary" /> : null}
                                <p className="text-sm font-medium">{item.title}</p>
                                <p className="mt-1 text-sm text-muted-foreground">{item.body}</p>
                                <p className="mt-1 text-xs text-muted-foreground">{relativeTime(item.createdAt)}</p>
                            </Link>
                        ))
                    )}
                </div>
                <div className="border-t p-2 text-center">
                    <Button asChild variant="ghost" size="sm">
                        <Link href="/settings#notifications" onClick={() => setOpen(false)}>Notification settings</Link>
                    </Button>
                </div>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
function relativeTime(value: string) {
    const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1_000));
    if (seconds < 60) return 'Just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
}
