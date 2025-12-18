'use client';

import { useMemo, useState } from 'react';
import { Check, ChevronDown, X } from 'lucide-react';
import { cn } from '@/lib/utils';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
    DropdownMenu,
    DropdownMenuCheckboxItem,
    DropdownMenuContent,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export type MultiSelectOption = {
    value: string;
    label: string;
    count?: number;
};

export function MultiSelect({
    options,
    value,
    onChange,
    placeholder = 'Select…',
    searchPlaceholder = 'Search…',
    maxBadges = 2,
    disabled = false,
    className,
    triggerClassName,
}: {
    options: MultiSelectOption[];
    value: string[];
    onChange: (next: string[]) => void;
    placeholder?: string;
    searchPlaceholder?: string;
    maxBadges?: number;
    disabled?: boolean;
    className?: string;
    triggerClassName?: string;
}) {
    const [query, setQuery] = useState('');

    const selected = useMemo(() => {
        const set = new Set((value ?? []).map((v) => String(v)));
        return options.filter((o) => set.has(o.value));
    }, [options, value]);

    const filtered = useMemo(() => {
        const q = (query ?? '').trim().toLowerCase();
        if (!q) return options;
        return options.filter((o) => {
            const hay = `${o.label} ${o.value}`.toLowerCase();
            return hay.includes(q);
        });
    }, [options, query]);

    const summaryText = useMemo(() => {
        if (selected.length === 0) return placeholder;
        if (selected.length === 1) return selected[0]?.label ?? placeholder;
        return `${selected.length} selected`;
    }, [selected, placeholder]);

    function toggle(val: string) {
        const v = String(val);
        const set = new Set((value ?? []).map((x) => String(x)));
        if (set.has(v)) set.delete(v);
        else set.add(v);
        onChange(Array.from(set));
    }

    function clear() {
        if ((value ?? []).length === 0) return;
        onChange([]);
    }

    return (
        <div className={cn('space-y-2', className)}>
            <DropdownMenu>
                <DropdownMenuTrigger asChild disabled={disabled}>
                    <Button
                        type="button"
                        variant="outline"
                        className={cn(
                            'w-full justify-between gap-2',
                            triggerClassName
                        )}
                    >
                        <span className="min-w-0 truncate text-left">
                            {summaryText}
                        </span>
                        <ChevronDown className="h-4 w-4 opacity-60" />
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                    align="start"
                    className="w-[var(--radix-dropdown-menu-trigger-width)] p-2"
                >
                    <div className="space-y-2">
                        <Input
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            placeholder={searchPlaceholder}
                            className="h-8 text-xs"
                        />

                        {selected.length > 0 ? (
                            <div className="flex flex-wrap gap-1">
                                {selected.slice(0, maxBadges).map((o) => (
                                    <Badge
                                        key={o.value}
                                        variant="secondary"
                                        className="flex items-center gap-1"
                                    >
                                        <span className="truncate max-w-[14rem]">
                                            {o.label}
                                        </span>
                                        <button
                                            type="button"
                                            className="rounded-sm hover:bg-muted"
                                            onClick={(e) => {
                                                e.preventDefault();
                                                e.stopPropagation();
                                                toggle(o.value);
                                            }}
                                            aria-label={`Remove ${o.label}`}
                                        >
                                            <X className="h-3 w-3" />
                                        </button>
                                    </Badge>
                                ))}
                                {selected.length > maxBadges ? (
                                    <Badge variant="secondary">
                                        +{selected.length - maxBadges}
                                    </Badge>
                                ) : null}
                            </div>
                        ) : null}

                        <DropdownMenuSeparator />
                    </div>

                    <div className="max-h-72 overflow-auto">
                        {filtered.length === 0 ? (
                            <div className="px-2 py-2 text-xs text-muted-foreground">
                                No matches.
                            </div>
                        ) : (
                            filtered.slice(0, 500).map((o) => {
                                const checked = (value ?? []).includes(o.value);
                                return (
                                    <DropdownMenuCheckboxItem
                                        key={o.value}
                                        checked={checked}
                                        onCheckedChange={() => toggle(o.value)}
                                        className="flex items-center justify-between gap-2"
                                    >
                                        <span className="min-w-0 truncate">
                                            {o.label}
                                        </span>
                                        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                                            {typeof o.count === 'number'
                                                ? o.count.toLocaleString()
                                                : ''}
                                        </span>
                                    </DropdownMenuCheckboxItem>
                                );
                            })
                        )}
                    </div>

                    <DropdownMenuSeparator />
                    <div className="flex items-center justify-between gap-2 p-1">
                        <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-xs"
                            onClick={clear}
                            disabled={selected.length === 0}
                        >
                            Clear
                        </Button>
                        <div className="text-xs text-muted-foreground">
                            <Check className="inline h-3 w-3 mr-1" />
                            {selected.length}
                        </div>
                    </div>
                </DropdownMenuContent>
            </DropdownMenu>
        </div>
    );
}

