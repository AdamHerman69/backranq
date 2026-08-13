'use client';

import * as React from 'react';
import Link from 'next/link';
import { Bell, CheckCheck } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EXPECTED_OWNER_HEADER } from '@/lib/auth/ownerContract';

export type NotificationItem = {
    id: string;
    title: string;
    body: string;
    href: string | null;
    readAt: string | null;
    createdAt: string;
};

export type NotificationInboxState = {
    items: NotificationItem[];
    unreadCount: number;
    loading: boolean;
    loadError: boolean;
    writeError: string | null;
    writePending: boolean;
};

type InboxAction =
    | { type: 'RESET'; enabled: boolean }
    | { type: 'LOAD_START' }
    | { type: 'LOAD_FAILED' }
    | { type: 'LOADED'; items: NotificationItem[]; unreadCount: number }
    | { type: 'MARK_ONE'; id: string; now: string }
    | { type: 'MARK_ALL'; now: string }
    | { type: 'WRITE_DONE' }
    | { type: 'RESTORE'; snapshot: NotificationInboxState; error: string };

export function notificationInboxReducer(
    state: NotificationInboxState,
    action: InboxAction
): NotificationInboxState {
    switch (action.type) {
        case 'RESET':
            return initialInboxState(action.enabled);
        case 'LOAD_START':
            return { ...state, loading: true };
        case 'LOAD_FAILED':
            return { ...state, loading: false, loadError: true };
        case 'LOADED':
            return {
                ...state,
                items: action.items,
                unreadCount: action.unreadCount,
                loading: false,
                loadError: false,
            };
        case 'MARK_ONE': {
            const target = state.items.find((item) => item.id === action.id);
            if (!target || target.readAt) return state;
            return {
                ...state,
                items: state.items.map((item) =>
                    item.id === action.id
                        ? { ...item, readAt: action.now }
                        : item
                ),
                unreadCount: Math.max(0, state.unreadCount - 1),
                writeError: null,
                writePending: true,
            };
        }
        case 'MARK_ALL':
            return {
                ...state,
                items: state.items.map((item) => ({
                    ...item,
                    readAt: item.readAt ?? action.now,
                })),
                unreadCount: 0,
                writeError: null,
                writePending: true,
            };
        case 'WRITE_DONE':
            return { ...state, writePending: false, writeError: null };
        case 'RESTORE':
            return {
                ...action.snapshot,
                writePending: false,
                writeError: action.error,
            };
    }
}

function initialInboxState(enabled: boolean): NotificationInboxState {
    return {
        items: [],
        unreadCount: 0,
        loading: enabled,
        loadError: false,
        writeError: null,
        writePending: false,
    };
}

export function NotificationBell({ ownerId }: { ownerId: string | null }) {
    const [state, dispatch] = React.useReducer(
        notificationInboxReducer,
        Boolean(ownerId),
        initialInboxState
    );
    const [open, setOpen] = React.useState(false);
    const stateRef = React.useRef(state);
    stateRef.current = state;
    const ownerRef = React.useRef(ownerId);
    ownerRef.current = ownerId;
    const loadGenerationRef = React.useRef(0);
    const loadControllerRef = React.useRef<AbortController | null>(null);
    const writeControllerRef = React.useRef<AbortController | null>(null);

    const load = React.useCallback(async () => {
        if (!ownerId) return;
        const generation = ++loadGenerationRef.current;
        loadControllerRef.current?.abort();
        const controller = new AbortController();
        loadControllerRef.current = controller;
        dispatch({ type: 'LOAD_START' });
        try {
            const response = await fetch('/api/notifications?limit=10', {
                cache: 'no-store',
                signal: controller.signal,
            });
            const payload = (await response.json().catch(() => ({}))) as {
                ownerId?: string;
                notifications?: NotificationItem[];
                unreadCount?: number;
            };
            if (!response.ok || payload.ownerId !== ownerId) {
                throw new Error('Notification load failed');
            }
            if (
                controller.signal.aborted ||
                generation !== loadGenerationRef.current ||
                ownerRef.current !== ownerId
            ) {
                return;
            }
            dispatch({
                type: 'LOADED',
                items: payload.notifications ?? [],
                unreadCount: payload.unreadCount ?? 0,
            });
        } catch (error) {
            if (
                controller.signal.aborted ||
                generation !== loadGenerationRef.current ||
                ownerRef.current !== ownerId ||
                (error instanceof Error && error.name === 'AbortError')
            ) {
                return;
            }
            dispatch({ type: 'LOAD_FAILED' });
        } finally {
            if (loadControllerRef.current === controller) {
                loadControllerRef.current = null;
            }
        }
    }, [ownerId]);

    React.useEffect(() => {
        loadGenerationRef.current += 1;
        loadControllerRef.current?.abort();
        writeControllerRef.current?.abort();
        dispatch({ type: 'RESET', enabled: Boolean(ownerId) });
        setOpen(false);
        if (!ownerId) return;
        void load();
        const timer = window.setInterval(() => {
            if (document.visibilityState === 'visible') void load();
        }, 60_000);
        return () => {
            window.clearInterval(timer);
            loadGenerationRef.current += 1;
            loadControllerRef.current?.abort();
            writeControllerRef.current?.abort();
        };
    }, [ownerId, load]);

    async function write(action: 'mark-read' | 'mark-all-read', id?: string) {
        if (!ownerId || stateRef.current.writePending) return;
        const snapshot = stateRef.current;
        const now = new Date().toISOString();
        dispatch(
            action === 'mark-read' && id
                ? { type: 'MARK_ONE', id, now }
                : { type: 'MARK_ALL', now }
        );
        loadGenerationRef.current += 1;
        loadControllerRef.current?.abort();
        const controller = new AbortController();
        writeControllerRef.current = controller;
        try {
            const response = await fetch('/api/notifications', {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    [EXPECTED_OWNER_HEADER]: ownerId,
                },
                body: JSON.stringify({ action, ...(id ? { id } : {}) }),
                signal: controller.signal,
                keepalive: true,
            });
            const payload = (await response.json().catch(() => ({}))) as {
                ownerId?: string;
                error?: string;
            };
            if (!response.ok || payload.ownerId !== ownerId) {
                throw new Error(payload.error ?? 'Notification update failed');
            }
            if (ownerRef.current !== ownerId) return;
            dispatch({ type: 'WRITE_DONE' });
            void load();
        } catch (error) {
            if (
                controller.signal.aborted ||
                ownerRef.current !== ownerId ||
                (error instanceof Error && error.name === 'AbortError')
            ) {
                return;
            }
            const message =
                error instanceof Error
                    ? error.message
                    : 'Notification update failed';
            dispatch({ type: 'RESTORE', snapshot, error: message });
            toast.error(message);
        } finally {
            if (writeControllerRef.current === controller) {
                writeControllerRef.current = null;
            }
        }
    }

    if (!ownerId) return null;
    return (
        <DropdownMenu
            open={open}
            onOpenChange={(next) => {
                setOpen(next);
                if (next) void load();
            }}
        >
            <DropdownMenuTrigger asChild>
                <Button
                    variant="ghost"
                    size="icon"
                    className="relative"
                    aria-label={`Notifications${state.unreadCount ? `, ${state.unreadCount} unread` : ''}`}
                >
                    <Bell />
                    {state.unreadCount > 0 ? (
                        <Badge
                            className="absolute -right-1 -top-1 min-w-5 justify-center px-1 text-[10px]"
                            aria-hidden="true"
                        >
                            {state.unreadCount > 99 ? '99+' : state.unreadCount}
                        </Badge>
                    ) : null}
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
                align="end"
                className="w-[min(24rem,calc(100vw-1rem))] p-0"
            >
                <div className="flex items-center justify-between border-b px-4 py-3">
                    <p className="font-semibold">Notifications</p>
                    {state.unreadCount > 0 ? (
                        <Button
                            variant="ghost"
                            size="sm"
                            disabled={state.writePending}
                            onClick={() => void write('mark-all-read')}
                        >
                            <CheckCheck className="mr-1 h-4 w-4" /> Mark all read
                        </Button>
                    ) : null}
                </div>
                {state.writeError ? (
                    <p className="border-b px-4 py-2 text-sm text-destructive" role="alert">
                        {state.writeError}
                    </p>
                ) : null}
                <div className="max-h-[26rem] overflow-y-auto">
                    {state.loading && state.items.length === 0 ? (
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
                    ) : state.loadError && state.items.length === 0 ? (
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
                    ) : state.items.length === 0 ? (
                        <p className="p-6 text-center text-sm text-muted-foreground">
                            You are all caught up.
                        </p>
                    ) : (
                        state.items.map((item) => (
                            <Link
                                key={item.id}
                                href={item.href ?? '/home'}
                                onClick={() => {
                                    void write('mark-read', item.id);
                                    setOpen(false);
                                }}
                                className="relative block border-b px-4 py-3 last:border-0 hover:bg-muted/50"
                            >
                                {!item.readAt ? (
                                    <span className="absolute left-1.5 top-5 h-2 w-2 rounded-full bg-primary" />
                                ) : null}
                                <p className="text-sm font-medium">{item.title}</p>
                                <p className="mt-1 text-sm text-muted-foreground">{item.body}</p>
                                <p className="mt-1 text-xs text-muted-foreground">
                                    {relativeTime(item.createdAt)}
                                </p>
                            </Link>
                        ))
                    )}
                </div>
                <div className="border-t p-2 text-center">
                    <Button asChild variant="ghost" size="sm">
                        <Link
                            href="/settings#notifications"
                            onClick={() => setOpen(false)}
                        >
                            Notification settings
                        </Link>
                    </Button>
                </div>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

function relativeTime(value: string) {
    const seconds = Math.max(
        0,
        Math.round((Date.now() - new Date(value).getTime()) / 1_000)
    );
    if (seconds < 60) return 'Just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
}
