import type { LucideIcon } from 'lucide-react';
import {
    House,
    Library,
    LineChart,
    Settings,
    Swords,
    Target,
} from 'lucide-react';

export type NavItem = {
    href: string;
    label: string;
    icon: LucideIcon;
    active?: (pathname: string) => boolean;
};

export const appNavItems: NavItem[] = [
    {
        href: '/home',
        label: 'Home',
        icon: House,
        active: (pathname) =>
            pathname === '/home' || pathname.startsWith('/home/'),
    },
    {
        href: '/practice',
        label: 'Practice',
        icon: Target,
        active: (pathname) =>
            pathname === '/practice' || pathname.startsWith('/practice/'),
    },
    {
        href: '/play',
        label: 'Play',
        icon: Swords,
        active: (pathname) =>
            pathname === '/play' || pathname.startsWith('/play/'),
    },
    {
        href: '/games',
        label: 'Games',
        icon: Library,
        active: (pathname) =>
            pathname === '/games' || pathname.startsWith('/games/'),
    },
    {
        href: '/progress',
        label: 'Progress',
        icon: LineChart,
        active: (pathname) =>
            pathname === '/progress' || pathname.startsWith('/progress/'),
    },
    {
        href: '/settings',
        label: 'Settings',
        icon: Settings,
        active: (pathname) =>
            pathname === '/settings' || pathname.startsWith('/settings/'),
    },
];

export const primaryNavItems = appNavItems.filter(
    (item) => item.href !== '/settings'
);

export function itemIsActive(item: NavItem, pathname: string) {
    return item.active ? item.active(pathname) : pathname === item.href;
}
